use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use ssh2::Session;
use tauri::{Emitter, AppHandle};
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SshConfig {
    pub id: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: Option<String>,
    pub private_key: Option<String>,
}

pub enum ShellCommand {
    Write(Vec<u8>),
    Resize { rows: u32, cols: u32 },
    Close,
}

pub struct ShellSession {
    pub sender: mpsc::Sender<ShellCommand>,
    pub session: Arc<Mutex<Session>>,
}

pub struct AppState {
    pub sessions: Arc<Mutex<HashMap<String, ShellSession>>>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

#[tauri::command]
pub async fn connect_ssh(
    state: tauri::State<'_, AppState>,
    config: SshConfig,
    app_handle: AppHandle,
) -> Result<String, String> {
    let (tx, rx) = mpsc::channel::<ShellCommand>();
    let config_clone = config.clone();

    thread::spawn(move || {
        let tcp = match TcpStream::connect(format!("{}:{}", config_clone.host, config_clone.port)) {
            Ok(t) => t,
            Err(e) => {
                let _ = app_handle.emit(&format!("ssh_error_{}", config_clone.id), e.to_string());
                return;
            }
        };

        let mut sess = match Session::new() {
            Ok(s) => s,
            Err(e) => {
                let _ = app_handle.emit(&format!("ssh_error_{}", config_clone.id), e.to_string());
                return;
            }
        };

        sess.set_tcp_stream(tcp);
        if let Err(e) = sess.handshake() {
            let _ = app_handle.emit(&format!("ssh_error_{}", config_clone.id), e.to_string());
            return;
        }

        if let Some(pwd) = &config_clone.password {
            if let Err(e) = sess.userauth_password(&config_clone.username, pwd) {
                let _ = app_handle.emit(&format!("ssh_error_{}", config_clone.id), e.to_string());
                return;
            }
        } else {
             // TODO: Key auth
        }

        if !sess.authenticated() {
            let _ = app_handle.emit(&format!("ssh_error_{}", config_clone.id), "Authentication failed");
            return;
        }

        let mut channel = match sess.channel_session() {
            Ok(c) => c,
            Err(e) => {
                let _ = app_handle.emit(&format!("ssh_error_{}", config_clone.id), e.to_string());
                return;
            }
        };

        if let Err(e) = channel.request_pty("xterm", None, Some((80, 24, 0, 0))) {
            let _ = app_handle.emit(&format!("ssh_error_{}", config_clone.id), e.to_string());
            return;
        }

        if let Err(e) = channel.shell() {
            let _ = app_handle.emit(&format!("ssh_error_{}", config_clone.id), e.to_string());
            return;
        }
        
        let _ = app_handle.emit(&format!("ssh_connected_{}", config_clone.id), "Connected");

        sess.set_blocking(false);

        let mut buf = [0u8; 4096];
        loop {
            // 1. Handle commands from frontend
            while let Ok(cmd) = rx.try_recv() {
                match cmd {
                    ShellCommand::Write(data) => {
                        let _ = channel.write_all(&data);
                        let _ = channel.flush();
                    }
                    ShellCommand::Resize { rows, cols } => {
                        let _ = channel.request_pty_size(cols, rows, None, None);
                    }
                    ShellCommand::Close => {
                        let _ = channel.close();
                        return;
                    }
                }
            }

            // 2. Read from SSH channel
            match channel.read(&mut buf) {
                Ok(n) if n > 0 => {
                    let data = &buf[0..n];
                    let s = String::from_utf8_lossy(data).to_string();
                    let _ = app_handle.emit(&format!("ssh_data_{}", config_clone.id), s);
                }
                Ok(_) => {
                    // EOF or no data in non-blocking
                }
                Err(e) => {
                    if e.kind() != std::io::ErrorKind::WouldBlock {
                        break;
                    }
                }
            }
            
            thread::sleep(std::time::Duration::from_millis(10));
        }
        
        let _ = app_handle.emit(&format!("ssh_closed_{}", config_clone.id), "Closed");
    });

    // Create a new session for SFTP operations
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
        return Err("Authentication failed".to_string());
    }

    let session_arc = Arc::new(Mutex::new(sess2));
    let mut sessions = state.sessions.lock().unwrap();
    sessions.insert(config.id.clone(), ShellSession { 
        sender: tx,
        session: session_arc,
    });

    Ok("Connecting...".to_string())
}

#[tauri::command]
pub fn send_command(
    state: tauri::State<'_, AppState>,
    id: String,
    command: String,
) -> Result<(), String> {
    let sessions = state.sessions.lock().unwrap();
    if let Some(session) = sessions.get(&id) {
        let _ = session.sender.send(ShellCommand::Write(command.into_bytes()));
        Ok(())
    } else {
        Err("Session not found".to_string())
    }
}

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
