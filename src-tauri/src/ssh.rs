use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::{mpsc, Arc, Mutex, RwLock};
use std::thread::{self, JoinHandle};
use std::time::{Duration, SystemTime};
use ssh2::Session;
use tauri::{Emitter, AppHandle};
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SshConfig {
    pub id: String,
    pub name: Option<String>,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: Option<String>,
    pub private_key: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SessionStatus {
    pub id: String,
    pub connected: bool,
    pub active: bool,
    pub last_activity: u64,
    pub thread_id: String,
}

pub enum ShellCommand {
    Write(Vec<u8>),
    Resize { rows: u32, cols: u32 },
    KeepAlive,
    Close,
}

/// 单个SSH会话的完整管理结构
pub struct ShellSession {
    pub sender: mpsc::Sender<ShellCommand>,
    pub session: Arc<Mutex<Session>>,
    pub thread_handle: Option<JoinHandle<()>>,
    pub status: Arc<RwLock<SessionStatus>>,
    pub config: SshConfig,
}

impl ShellSession {
    pub fn is_alive(&self) -> bool {
        if let Some(handle) = &self.thread_handle {
            !handle.is_finished()
        } else {
            false
        }
    }

    pub fn update_activity(&self) {
        if let Ok(mut status) = self.status.write() {
            status.last_activity = SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_secs();
            status.active = true;
        }
    }

    pub fn get_status(&self) -> Option<SessionStatus> {
        self.status.read().ok().map(|s| s.clone())
    }
}

/// 全局会话池管理器
pub struct AppState {
    pub sessions: Arc<Mutex<HashMap<String, ShellSession>>>,
    pub active_session: Arc<Mutex<Option<String>>>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            active_session: Arc::new(Mutex::new(None)),
        }
    }

    /// 清理已断开的会话
    pub fn cleanup_dead_sessions(&self) {
        if let Ok(mut sessions) = self.sessions.lock() {
            sessions.retain(|_, session| session.is_alive());
        }
    }

    /// 获取所有会话状态
    pub fn get_all_status(&self) -> Vec<SessionStatus> {
        if let Ok(sessions) = self.sessions.lock() {
            sessions.values()
                .filter_map(|s| s.get_status())
                .collect()
        } else {
            Vec::new()
        }
    }
}

/// 创建SSH连接并在独立线程中运行
#[tauri::command]
pub async fn connect_ssh(
    state: tauri::State<'_, AppState>,
    config: SshConfig,
    app_handle: AppHandle,
) -> Result<String, String> {
    let session_id = config.id.clone();
    
    // 检查会话是否已存在
    {
        let sessions = state.sessions.lock().unwrap();
        if sessions.contains_key(&session_id) {
            return Err("Session already exists".to_string());
        }
    }

    let (tx, rx) = mpsc::channel::<ShellCommand>();
    let config_clone = config.clone();
    let app_handle_clone = app_handle.clone();

    // 创建会话状态跟踪
    let status = Arc::new(RwLock::new(SessionStatus {
        id: session_id.clone(),
        connected: false,
        active: false,
        last_activity: SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_secs(),
        thread_id: String::new(),
    }));

    let status_clone = status.clone();

    // 在独立线程中运行SSH会话
    let thread_handle = thread::spawn(move || {
        // 更新线程ID
        {
            if let Ok(mut s) = status_clone.write() {
                s.thread_id = format!("{:?}", thread::current().id());
            }
        }

        // 建立TCP连接
        let tcp = match TcpStream::connect(format!("{}:{}", config_clone.host, config_clone.port)) {
            Ok(t) => t,
            Err(e) => {
                let _ = app_handle_clone.emit(&format!("ssh_error_{}", config_clone.id), e.to_string());
                return;
            }
        };

        // 创建SSH会话
        let mut sess = match Session::new() {
            Ok(s) => s,
            Err(e) => {
                let _ = app_handle_clone.emit(&format!("ssh_error_{}", config_clone.id), e.to_string());
                return;
            }
        };

        sess.set_tcp_stream(tcp);
        if let Err(e) = sess.handshake() {
            let _ = app_handle_clone.emit(&format!("ssh_error_{}", config_clone.id), e.to_string());
            return;
        }

        // 认证
        if let Some(pwd) = &config_clone.password {
            if let Err(e) = sess.userauth_password(&config_clone.username, pwd) {
                let _ = app_handle_clone.emit(&format!("ssh_error_{}", config_clone.id), e.to_string());
                return;
            }
        } else if let Some(_key_path) = &config_clone.private_key {
            // TODO: 实现密钥认证
            let _ = app_handle_clone.emit(&format!("ssh_error_{}", config_clone.id), 
                "Private key authentication not yet implemented".to_string());
            return;
        }

        if !sess.authenticated() {
            let _ = app_handle_clone.emit(&format!("ssh_error_{}", config_clone.id), "Authentication failed");
            return;
        }

        // 打开Shell通道
        let mut channel = match sess.channel_session() {
            Ok(c) => c,
            Err(e) => {
                let _ = app_handle_clone.emit(&format!("ssh_error_{}", config_clone.id), e.to_string());
                return;
            }
        };

        if let Err(e) = channel.request_pty("xterm-256color", None, Some((80, 24, 0, 0))) {
            let _ = app_handle_clone.emit(&format!("ssh_error_{}", config_clone.id), e.to_string());
            return;
        }

        if let Err(e) = channel.shell() {
            let _ = app_handle_clone.emit(&format!("ssh_error_{}", config_clone.id), e.to_string());
            return;
        }

        // 更新状态为已连接
        {
            if let Ok(mut s) = status_clone.write() {
                s.connected = true;
                s.active = true;
            }
        }
        
        let _ = app_handle_clone.emit(&format!("ssh_connected_{}", config_clone.id), "Connected");

        sess.set_blocking(false);

        let mut buf = [0u8; 8192];
        let mut last_keepalive = SystemTime::now();

        // 主循环 - 处理命令和数据
        loop {
            // 1. 处理来自前端的命令
            while let Ok(cmd) = rx.try_recv() {
                match cmd {
                    ShellCommand::Write(data) => {
                        if let Err(e) = channel.write_all(&data) {
                            eprintln!("Write error: {}", e);
                            break;
                        }
                        let _ = channel.flush();
                        
                        // 更新活动时间
                        if let Ok(mut s) = status_clone.write() {
                            s.last_activity = SystemTime::now()
                                .duration_since(SystemTime::UNIX_EPOCH)
                                .unwrap()
                                .as_secs();
                        }
                    }
                    ShellCommand::Resize { rows, cols } => {
                        let _ = channel.request_pty_size(cols, rows, None, None);
                    }
                    ShellCommand::KeepAlive => {
                        // 保持会话活跃
                        last_keepalive = SystemTime::now();
                    }
                    ShellCommand::Close => {
                        if let Ok(mut s) = status_clone.write() {
                            s.connected = false;
                            s.active = false;
                        }
                        let _ = channel.close();
                        return;
                    }
                }
            }

            // 2. 从SSH通道读取数据
            match channel.read(&mut buf) {
                Ok(n) if n > 0 => {
                    let data = &buf[0..n];
                    let s = String::from_utf8_lossy(data).to_string();
                    let _ = app_handle_clone.emit(&format!("ssh_data_{}", config_clone.id), s);
                    
                    // 更新活动时间
                    if let Ok(mut s) = status_clone.write() {
                        s.last_activity = SystemTime::now()
                            .duration_since(SystemTime::UNIX_EPOCH)
                            .unwrap()
                            .as_secs();
                    }
                }
                Ok(_) => {
                    // EOF 或无数据
                }
                Err(e) => {
                    if e.kind() != std::io::ErrorKind::WouldBlock {
                        eprintln!("Read error: {}", e);
                        break;
                    }
                }
            }

            // 3. 定期发送keepalive
            if last_keepalive.elapsed().unwrap_or(Duration::from_secs(0)) > Duration::from_secs(30) {
                if let Err(_) = sess.keepalive_send() {
                    eprintln!("Keepalive failed");
                    break;
                }
                last_keepalive = SystemTime::now();
            }

            // 4. 检查通道是否已关闭
            if channel.eof() {
                break;
            }
            
            thread::sleep(Duration::from_millis(10));
        }
        
        // 清理
        if let Ok(mut s) = status_clone.write() {
            s.connected = false;
            s.active = false;
        }
        let _ = app_handle_clone.emit(&format!("ssh_closed_{}", config_clone.id), "Closed");
    });

    // 为SFTP创建另一个SSH会话
    let tcp2 = TcpStream::connect(format!("{}:{}", config.host, config.port))
        .map_err(|e| e.to_string())?;
    let mut sess2 = Session::new().map_err(|e| e.to_string())?;
    sess2.set_tcp_stream(tcp2);
    sess2.handshake().map_err(|e| e.to_string())?;
    
    if let Some(pwd) = &config.password {
        sess2.userauth_password(&config.username, pwd)
            .map_err(|e| e.to_string())?;
    }
    
    if !sess2.authenticated() {
        return Err("SFTP session authentication failed".to_string());
    }

    let session_arc = Arc::new(Mutex::new(sess2));
    
    // 保存会话到状态管理
    let mut sessions = state.sessions.lock().unwrap();
    sessions.insert(session_id.clone(), ShellSession { 
        sender: tx,
        session: session_arc,
        thread_handle: Some(thread_handle),
        status,
        config: config.clone(),
    });

    // 设置为活跃会话
    let mut active = state.active_session.lock().unwrap();
    *active = Some(session_id.clone());

    Ok(session_id)
}

/// 发送命令到指定会话
#[tauri::command]
pub fn send_command(
    state: tauri::State<'_, AppState>,
    id: String,
    command: String,
) -> Result<(), String> {
    let sessions = state.sessions.lock().unwrap();
    if let Some(session) = sessions.get(&id) {
        session.update_activity();
        let _ = session.sender.send(ShellCommand::Write(command.into_bytes()));
        Ok(())
    } else {
        Err("Session not found".to_string())
    }
}

/// 调整终端大小
#[tauri::command]
pub fn resize_term(
    state: tauri::State<'_, AppState>,
    id: String,
    rows: u32,
    cols: u32,
) -> Result<(), String> {
    let sessions = state.sessions.lock().unwrap();
    if let Some(session) = sessions.get(&id) {
        let _ = session.sender.send(ShellCommand::Resize { rows, cols });
        Ok(())
    } else {
        Err("Session not found".to_string())
    }
}

/// 关闭SSH会话
#[tauri::command]
pub fn close_session(
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    let mut sessions = state.sessions.lock().unwrap();
    if let Some(session) = sessions.remove(&id) {
        let _ = session.sender.send(ShellCommand::Close);
        Ok(())
    } else {
        Err("Session not found".to_string())
    }
}

/// 设置活跃会话(当用户切换标签页时调用)
#[tauri::command]
pub fn set_active_session(
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    let sessions = state.sessions.lock().unwrap();
    if sessions.contains_key(&id) {
        let mut active = state.active_session.lock().unwrap();
        *active = Some(id.clone());
        
        // 发送keepalive确保会话活跃
        if let Some(session) = sessions.get(&id) {
            let _ = session.sender.send(ShellCommand::KeepAlive);
        }
        Ok(())
    } else {
        Err("Session not found".to_string())
    }
}

/// 获取所有会话状态
#[tauri::command]
pub fn get_sessions_status(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<SessionStatus>, String> {
    Ok(state.get_all_status())
}

/// 重新连接会话
#[tauri::command]
pub async fn reconnect_session(
    state: tauri::State<'_, AppState>,
    id: String,
    app_handle: AppHandle,
) -> Result<String, String> {
    // 先关闭旧会话
    let config = {
        let mut sessions = state.sessions.lock().unwrap();
        if let Some(session) = sessions.remove(&id) {
            let _ = session.sender.send(ShellCommand::Close);
            session.config.clone()
        } else {
            return Err("Session not found".to_string());
        }
    };

    // 等待一小段时间让旧连接完全关闭
    thread::sleep(Duration::from_millis(500));

    // 使用原配置重新连接
    connect_ssh(state, config, app_handle).await
}

/// 清理所有死掉的会话
#[tauri::command]
pub fn cleanup_sessions(
    state: tauri::State<'_, AppState>,
) -> Result<usize, String> {
    let mut sessions = state.sessions.lock().unwrap();
    let before_count = sessions.len();
    sessions.retain(|_, session| session.is_alive());
    let after_count = sessions.len();
    Ok(before_count - after_count)
}
