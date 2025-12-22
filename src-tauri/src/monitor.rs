use serde::Serialize;
use std::io::Read;

#[derive(Serialize, Clone)]
pub struct NetworkStats {
    name: String,
    rx_bytes: u64,
    tx_bytes: u64,
}

#[derive(Serialize, Clone)]
pub struct ProcessInfo {
    pid: u32,
    name: String,
    cpu: String,
    memory: String,
}

#[derive(Serialize, Clone)]
pub struct DiskInfo {
    filesystem: String,
    size: String,
    used: String,
    available: String,
    use_percent: String,
    mounted_on: String,
}

#[derive(Serialize, Clone)]
pub struct SystemStats {
    cpu_usage: f32,
    cpu_count: usize,
    memory_usage: u64,
    total_memory: u64,
    swap_usage: u64,
    total_swap: u64,
    networks: Vec<NetworkStats>,
}

pub struct MonitorState;

impl MonitorState {
    pub fn new() -> Self {
        Self
    }
}

fn parse_memory_line(line: &str) -> Option<u64> {
    line.split_whitespace()
        .nth(1)
        .and_then(|s| s.parse::<u64>().ok())
        .map(|kb| kb * 1024) // Convert KB to bytes
}

fn parse_top_cpu(output: &str) -> (f32, usize) {
    // Parse CPU usage from top command
    for line in output.lines() {
        if line.contains("Cpu(s)") || line.contains("%Cpu") {
            // Format: "%Cpu(s):  0.3 us,  0.2 sy,  0.0 ni, 99.5 id"
            // or "Cpu(s):  0.3%us,  0.2%sy,  0.0%ni, 99.5%id"
            if let Some(idle_part) = line.split(',').find(|s| s.contains("id")) {
                if let Some(idle_str) = idle_part.split_whitespace().next() {
                    if let Ok(idle) = idle_str.trim_end_matches("%id").parse::<f32>() {
                        return (100.0 - idle, 1);
                    }
                }
            }
        }
    }
    (0.0, 1)
}

#[tauri::command]
pub async fn get_system_stats(
    ssh_state: tauri::State<'_, crate::ssh::AppState>,
    session_id: String,
) -> Result<SystemStats, String> {
    let sessions = ssh_state.sessions.read().map_err(|e| e.to_string())?;
    let shell_session = sessions.get(&session_id).ok_or("Session not found")?;
    let session = &shell_session.session;

    // Get memory info
    let mut channel = session.channel_session().map_err(|e| e.to_string())?;
    channel.exec("free -b").map_err(|e| e.to_string())?;
    let mut mem_output = String::new();
    channel.read_to_string(&mut mem_output).map_err(|e| e.to_string())?;
    channel.wait_close().ok();

    // Get CPU and process count
    let mut channel = session.channel_session().map_err(|e| e.to_string())?;
    channel.exec("top -bn1 | head -20").map_err(|e| e.to_string())?;
    let mut top_output = String::new();
    channel.read_to_string(&mut top_output).map_err(|e| e.to_string())?;
    channel.wait_close().ok();

    // Get network stats
    let mut channel = session.channel_session().map_err(|e| e.to_string())?;
    channel.exec("cat /proc/net/dev").map_err(|e| e.to_string())?;
    let mut net_output = String::new();
    channel.read_to_string(&mut net_output).map_err(|e| e.to_string())?;
    channel.wait_close().ok();

    // Parse memory
    let mut total_memory = 0u64;
    let mut memory_usage = 0u64;
    let mut swap_usage = 0u64;
    let mut total_swap = 0u64;

    for line in mem_output.lines() {
        if line.starts_with("Mem:") {
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() >= 3 {
                total_memory = parts[1].parse().unwrap_or(0);
                memory_usage = parts[2].parse().unwrap_or(0);
            }
        } else if line.starts_with("Swap:") {
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() >= 3 {
                total_swap = parts[1].parse().unwrap_or(0);
                swap_usage = parts[2].parse().unwrap_or(0);
            }
        }
    }

    // Parse CPU
    let (cpu_usage, cpu_count) = parse_top_cpu(&top_output);

    // Parse network interfaces
    let mut networks = Vec::new();
    for line in net_output.lines().skip(2) {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() >= 10 {
            let interface = parts[0].trim_end_matches(':');
            if interface != "lo" { // Skip loopback
                networks.push(NetworkStats {
                    name: interface.to_string(),
                    rx_bytes: parts[1].parse().unwrap_or(0),
                    tx_bytes: parts[9].parse().unwrap_or(0),
                });
            }
        }
    }

    Ok(SystemStats {
        cpu_usage,
        cpu_count,
        memory_usage,
        total_memory,
        swap_usage,
        total_swap,
        networks,
    })
}

#[tauri::command]
pub async fn get_top_processes(
    ssh_state: tauri::State<'_, crate::ssh::AppState>,
    session_id: String,
) -> Result<Vec<ProcessInfo>, String> {
    let sessions = ssh_state.sessions.read().map_err(|e| e.to_string())?;
    let shell_session = sessions.get(&session_id).ok_or("Session not found")?;
    let session = &shell_session.session;

    // Get top processes
    let mut channel = session.channel_session().map_err(|e| e.to_string())?;
    channel.exec("ps aux --sort=-%cpu | head -6").map_err(|e| e.to_string())?;
    let mut output = String::new();
    channel.read_to_string(&mut output).map_err(|e| e.to_string())?;
    channel.wait_close().ok();

    let mut processes = Vec::new();
    
    // Skip header line
    for line in output.lines().skip(1) {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() >= 11 {
            let pid = parts[1].parse().unwrap_or(0);
            let cpu_raw: f32 = parts[2].parse().unwrap_or(0.0);
            let mem_percent: f32 = parts[3].parse().unwrap_or(0.0);
            // RSS in KB (column 5)
            let rss_kb: u64 = parts[5].parse().unwrap_or(0);
            let name = parts[10].to_string();
            
            // Format CPU: if > 100%, normalize it (divide by core count approximation)
            let cpu_display = if cpu_raw > 100.0 {
                format!("{:.1}%", cpu_raw / 10.0_f32.max(cpu_raw / 100.0).ceil())
            } else {
                format!("{:.1}%", cpu_raw)
            };
            
            // Format memory in MB
            let mem_mb = rss_kb as f64 / 1024.0;
            let mem_display = if mem_mb < 1024.0 {
                format!("{:.0}M", mem_mb)
            } else {
                format!("{:.1}G", mem_mb / 1024.0)
            };
            
            processes.push(ProcessInfo {
                pid,
                name,
                cpu: cpu_display,
                memory: mem_display,
            });
        }
    }

    Ok(processes)
}

#[tauri::command]
pub async fn get_disk_usage(
    ssh_state: tauri::State<'_, crate::ssh::AppState>,
    session_id: String,
) -> Result<Vec<DiskInfo>, String> {
    let sessions = ssh_state.sessions.read().map_err(|e| e.to_string())?;
    let shell_session = sessions.get(&session_id).ok_or("Session not found")?;
    let session = &shell_session.session;

    // Get disk usage using df -h
    let mut channel = session.channel_session().map_err(|e| e.to_string())?;
    channel.exec("df -h | grep -v tmpfs | grep -v devtmpfs").map_err(|e| e.to_string())?;
    let mut output = String::new();
    channel.read_to_string(&mut output).map_err(|e| e.to_string())?;
    channel.wait_close().ok();

    let mut disks = Vec::new();
    
    // Skip header line
    for line in output.lines().skip(1) {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() >= 6 {
            disks.push(DiskInfo {
                filesystem: parts[0].to_string(),
                size: parts[1].to_string(),
                used: parts[2].to_string(),
                available: parts[3].to_string(),
                use_percent: parts[4].to_string(),
                mounted_on: parts[5].to_string(),
            });
        }
    }

    Ok(disks)
}
