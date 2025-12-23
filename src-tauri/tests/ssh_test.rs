use eshell_lib::ssh::{AppState, SshConfig, SessionStatus, ShellCommand};
use std::sync::{mpsc, Arc, RwLock};
use std::thread;
use std::time::SystemTime;
use serde_json;

#[test]
fn test_ssh_config_serialization() {
    let config = SshConfig {
        id: "test-id".to_string(),
        name: Some("Test Server".to_string()),
        host: "192.168.1.1".to_string(),
        port: 22,
        username: "testuser".to_string(),
        password: Some("testpass".to_string()),
        private_key: None,
    };

    let json = serde_json::to_string(&config).unwrap();
    let deserialized: SshConfig = serde_json::from_str(&json).unwrap();

    assert_eq!(config.id, deserialized.id);
    assert_eq!(config.name, deserialized.name);
    assert_eq!(config.host, deserialized.host);
    assert_eq!(config.port, deserialized.port);
    assert_eq!(config.username, deserialized.username);
    assert_eq!(config.password, deserialized.password);
    assert_eq!(config.private_key, deserialized.private_key);
}

#[test]
fn test_ssh_config_with_private_key() {
    let config = SshConfig {
        id: "test-id-2".to_string(),
        name: None,
        host: "example.com".to_string(),
        port: 2222,
        username: "admin".to_string(),
        password: None,
        private_key: Some("-----BEGIN RSA PRIVATE KEY-----\n...".to_string()),
    };

    assert_eq!(config.id, "test-id-2");
    assert!(config.name.is_none());
    assert_eq!(config.port, 2222);
    assert!(config.password.is_none());
    assert!(config.private_key.is_some());
}

#[test]
fn test_session_status_creation() {
    let status = SessionStatus {
        id: "session-1".to_string(),
        connected: true,
        active: true,
        last_activity: SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_secs(),
        thread_id: "ThreadId(1)".to_string(),
    };

    assert_eq!(status.id, "session-1");
    assert!(status.connected);
    assert!(status.active);
    assert!(status.last_activity > 0);
    assert!(!status.thread_id.is_empty());
}

#[test]
fn test_shell_command_write() {
    let (tx, rx) = mpsc::channel::<ShellCommand>();
    let data = b"echo hello".to_vec();

    tx.send(ShellCommand::Write(data.clone())).unwrap();

    let received = rx.recv().unwrap();
    match received {
        ShellCommand::Write(d) => assert_eq!(d, data),
        _ => panic!("Expected Write command"),
    }
}

#[test]
fn test_shell_command_resize() {
    let (tx, rx) = mpsc::channel::<ShellCommand>();
    let rows = 24;
    let cols = 80;

    tx.send(ShellCommand::Resize { rows, cols }).unwrap();

    let received = rx.recv().unwrap();
    match received {
        ShellCommand::Resize { rows: r, cols: c } => {
            assert_eq!(r, rows);
            assert_eq!(c, cols);
        }
        _ => panic!("Expected Resize command"),
    }
}

#[test]
fn test_shell_command_keepalive() {
    let (tx, rx) = mpsc::channel::<ShellCommand>();

    tx.send(ShellCommand::KeepAlive).unwrap();

    let received = rx.recv().unwrap();
    match received {
        ShellCommand::KeepAlive => (),
        _ => panic!("Expected KeepAlive command"),
    }
}

#[test]
fn test_shell_command_close() {
    let (tx, rx) = mpsc::channel::<ShellCommand>();

    tx.send(ShellCommand::Close).unwrap();

    let received = rx.recv().unwrap();
    match received {
        ShellCommand::Close => (),
        _ => panic!("Expected Close command"),
    }
}

#[test]
fn test_app_state_creation() {
    let state = AppState::new();

    let sessions = state.sessions.read().unwrap();
    assert_eq!(sessions.len(), 0);

    let active = state.active_session.read().unwrap();
    assert!(active.is_none());
}

#[test]
fn test_app_state_cleanup_dead_sessions() {
    let state = AppState::new();
    
    let status = Arc::new(RwLock::new(SessionStatus {
        id: "test-session".to_string(),
        connected: true,
        active: true,
        last_activity: SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_secs(),
        thread_id: String::new(),
    }));

    let mut sessions = state.sessions.write().unwrap();
    let (tx, _rx) = mpsc::channel::<ShellCommand>();
    
    let config = SshConfig {
        id: "test-session".to_string(),
        name: None,
        host: "localhost".to_string(),
        port: 22,
        username: "test".to_string(),
        password: None,
        private_key: None,
    };

    let handle = thread::spawn(|| {});
    
    use ssh2::Session;
    let ssh_session = Session::new().unwrap();
    
    sessions.insert("test-session".to_string(), eshell_lib::ssh::ShellSession {
        sender: tx,
        session: ssh_session,
        thread_handle: Some(handle),
        status: status.clone(),
        config,
    });
    drop(sessions);

    state.cleanup_dead_sessions();

    let sessions = state.sessions.read().unwrap();
    assert_eq!(sessions.len(), 0);
}

#[test]
fn test_app_state_get_all_status() {
    let state = AppState::new();
    
    let status1 = Arc::new(RwLock::new(SessionStatus {
        id: "session-1".to_string(),
        connected: true,
        active: true,
        last_activity: SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_secs(),
        thread_id: String::new(),
    }));

    let status2 = Arc::new(RwLock::new(SessionStatus {
        id: "session-2".to_string(),
        connected: false,
        active: false,
        last_activity: SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_secs(),
        thread_id: String::new(),
    }));

    let config1 = SshConfig {
        id: "session-1".to_string(),
        name: None,
        host: "host1".to_string(),
        port: 22,
        username: "user1".to_string(),
        password: None,
        private_key: None,
    };

    let config2 = SshConfig {
        id: "session-2".to_string(),
        name: None,
        host: "host2".to_string(),
        port: 22,
        username: "user2".to_string(),
        password: None,
        private_key: None,
    };

    let mut sessions = state.sessions.write().unwrap();
    
    use ssh2::Session;
    let ssh_session1 = Session::new().unwrap();
    let ssh_session2 = Session::new().unwrap();
    
    let (tx1, _rx1) = mpsc::channel::<ShellCommand>();
    let (tx2, _rx2) = mpsc::channel::<ShellCommand>();
    
    let handle1 = thread::spawn(|| {});
    let handle2 = thread::spawn(|| {});
    
    sessions.insert("session-1".to_string(), eshell_lib::ssh::ShellSession {
        sender: tx1,
        session: ssh_session1,
        thread_handle: Some(handle1),
        status: status1,
        config: config1,
    });
    sessions.insert("session-2".to_string(), eshell_lib::ssh::ShellSession {
        sender: tx2,
        session: ssh_session2,
        thread_handle: Some(handle2),
        status: status2,
        config: config2,
    });
    drop(sessions);

    let all_status = state.get_all_status();
    assert_eq!(all_status.len(), 2);
    let ids: Vec<&str> = all_status.iter().map(|s| s.id.as_str()).collect();
    assert!(ids.contains(&"session-1"));
    assert!(ids.contains(&"session-2"));
}

#[test]
fn test_session_status_update() {
    let status = Arc::new(RwLock::new(SessionStatus {
        id: "test-session".to_string(),
        connected: true,
        active: false,
        last_activity: 0,
        thread_id: String::new(),
    }));

    {
        let mut s = status.write().unwrap();
        s.last_activity = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        s.active = true;
    }

    let s: std::sync::RwLockReadGuard<'_, SessionStatus> = status.read().unwrap();
    assert!(s.last_activity > 0);
    assert!(s.active);
}

#[test]
fn test_session_status_read() {
    let status: Arc<RwLock<SessionStatus>> = Arc::new(RwLock::new(SessionStatus {
        id: "test-session".to_string(),
        connected: true,
        active: true,
        last_activity: SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_secs(),
        thread_id: "ThreadId(123)".to_string(),
    }));

    let s = status.read().unwrap();
    assert_eq!(s.id, "test-session");
    assert!(s.connected);
    assert!(s.active);
    assert_eq!(s.thread_id, "ThreadId(123)");
}

#[test]
fn test_multiple_shell_commands() {
    let (tx, rx) = mpsc::channel::<ShellCommand>();

    tx.send(ShellCommand::Write(b"ls -la".to_vec())).unwrap();
    tx.send(ShellCommand::Resize { rows: 40, cols: 120 }).unwrap();
    tx.send(ShellCommand::Write(b"pwd".to_vec())).unwrap();
    tx.send(ShellCommand::KeepAlive).unwrap();
    tx.send(ShellCommand::Close).unwrap();

    let commands: Vec<ShellCommand> = rx.iter().take(5).collect();
    assert_eq!(commands.len(), 5);
}

#[test]
fn test_ssh_config_clone() {
    let config = SshConfig {
        id: "original".to_string(),
        name: Some("Original Config".to_string()),
        host: "192.168.1.100".to_string(),
        port: 22,
        username: "root".to_string(),
        password: Some("secret".to_string()),
        private_key: None,
    };

    let cloned = config.clone();
    assert_eq!(config.id, cloned.id);
    assert_eq!(config.name, cloned.name);
    assert_eq!(config.host, cloned.host);
    assert_eq!(config.port, cloned.port);
    assert_eq!(config.username, cloned.username);
    assert_eq!(config.password, cloned.password);
    assert_eq!(config.private_key, cloned.private_key);
}

#[test]
fn test_session_status_clone() {
    let status = SessionStatus {
        id: "session-clone".to_string(),
        connected: true,
        active: true,
        last_activity: 9876543210,
        thread_id: "ThreadId(999)".to_string(),
    };

    let cloned = status.clone();
    assert_eq!(status.id, cloned.id);
    assert_eq!(status.connected, cloned.connected);
    assert_eq!(status.active, cloned.active);
    assert_eq!(status.last_activity, cloned.last_activity);
    assert_eq!(status.thread_id, cloned.thread_id);
}

#[test]
fn test_app_state_concurrent_access() {
    let state = Arc::new(AppState::new());
    let mut handles = vec![];

    for i in 0..10 {
        let state_clone = Arc::clone(&state);
        let handle = thread::spawn(move || {
            let (tx, _rx) = mpsc::channel::<ShellCommand>();
            let status = Arc::new(RwLock::new(SessionStatus {
                id: format!("session-{}", i),
                connected: true,
                active: true,
                last_activity: SystemTime::now()
                    .duration_since(SystemTime::UNIX_EPOCH)
                    .unwrap()
                    .as_secs(),
                thread_id: String::new(),
            }));

            let config = SshConfig {
                id: format!("session-{}", i),
                name: None,
                host: "localhost".to_string(),
                port: 22,
                username: "test".to_string(),
                password: None,
                private_key: None,
            };

            use ssh2::Session;
            let ssh_session = Session::new().unwrap();
            let thread_handle = thread::spawn(|| {});

            let mut sessions = state_clone.sessions.write().unwrap();
            sessions.insert(format!("session-{}", i), eshell_lib::ssh::ShellSession {
                sender: tx,
                session: ssh_session,
                thread_handle: Some(thread_handle),
                status,
                config,
            });
        });
        handles.push(handle);
    }

    for handle in handles {
        handle.join().unwrap();
    }

    let sessions = state.sessions.read().unwrap();
    assert_eq!(sessions.len(), 10);
}

#[test]
fn test_shell_command_channel_capacity() {
    let (tx, rx) = mpsc::sync_channel::<ShellCommand>(100);

    for i in 0..100 {
        tx.send(ShellCommand::Write(format!("command {}", i).into_bytes())).unwrap();
    }

    for _ in 0..100 {
        rx.recv().unwrap();
    }

    assert!(rx.try_recv().is_err());
}

#[test]
fn test_ssh_config_default_values() {
    let config = SshConfig {
        id: "default".to_string(),
        name: None,
        host: "localhost".to_string(),
        port: 22,
        username: "user".to_string(),
        password: None,
        private_key: None,
    };

    assert_eq!(config.port, 22);
    assert!(config.name.is_none());
    assert!(config.password.is_none());
    assert!(config.private_key.is_none());
}

#[test]
fn test_session_status_timestamp() {
    let now = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap()
        .as_secs();

    let status = SessionStatus {
        id: "timestamp-test".to_string(),
        connected: true,
        active: true,
        last_activity: now,
        thread_id: String::new(),
    };

    assert_eq!(status.last_activity, now);
    assert!(status.last_activity > 0);
}

#[test]
fn test_app_state_active_session() {
    let state = AppState::new();

    let mut active = state.active_session.write().unwrap();
    *active = Some("session-1".to_string());
    drop(active);

    let active = state.active_session.read().unwrap();
    assert_eq!(active.as_ref().unwrap(), "session-1");
}

#[test]
fn test_app_state_clear_active_session() {
    let state = AppState::new();

    let mut active = state.active_session.write().unwrap();
    *active = Some("session-1".to_string());
    drop(active);

    let mut active = state.active_session.write().unwrap();
    *active = None;
    drop(active);

    let active = state.active_session.read().unwrap();
    assert!(active.is_none());
}

#[test]
fn test_session_status_connected_active_states() {
    let status = SessionStatus {
        id: "test".to_string(),
        connected: false,
        active: false,
        last_activity: 0,
        thread_id: String::new(),
    };

    assert!(!status.connected);
    assert!(!status.active);

    let status = SessionStatus {
        id: "test".to_string(),
        connected: true,
        active: true,
        last_activity: 0,
        thread_id: String::new(),
    };

    assert!(status.connected);
    assert!(status.active);
}

#[test]
fn test_shell_command_write_empty() {
    let (tx, rx) = mpsc::channel::<ShellCommand>();
    let data = b"".to_vec();

    tx.send(ShellCommand::Write(data.clone())).unwrap();

    let received = rx.recv().unwrap();
    match received {
        ShellCommand::Write(d) => assert_eq!(d, data),
        _ => panic!("Expected Write command"),
    }
}

#[test]
fn test_shell_command_write_binary() {
    let (tx, rx) = mpsc::channel::<ShellCommand>();
    let data: Vec<u8> = vec![0x00, 0x01, 0x02, 0xFF, 0xFE];

    tx.send(ShellCommand::Write(data.clone())).unwrap();

    let received = rx.recv().unwrap();
    match received {
        ShellCommand::Write(d) => assert_eq!(d, data),
        _ => panic!("Expected Write command"),
    }
}

#[test]
fn test_shell_command_resize_zero() {
    let (tx, rx) = mpsc::channel::<ShellCommand>();
    let rows = 0;
    let cols = 0;

    tx.send(ShellCommand::Resize { rows, cols }).unwrap();

    let received = rx.recv().unwrap();
    match received {
        ShellCommand::Resize { rows: r, cols: c } => {
            assert_eq!(r, rows);
            assert_eq!(c, cols);
        }
        _ => panic!("Expected Resize command"),
    }
}

#[test]
fn test_shell_command_resize_large() {
    let (tx, rx) = mpsc::channel::<ShellCommand>();
    let rows = 1000;
    let cols = 1000;

    tx.send(ShellCommand::Resize { rows, cols }).unwrap();

    let received = rx.recv().unwrap();
    match received {
        ShellCommand::Resize { rows: r, cols: c } => {
            assert_eq!(r, rows);
            assert_eq!(c, cols);
        }
        _ => panic!("Expected Resize command"),
    }
}

#[test]
fn test_app_state_empty_sessions_status() {
    let state = AppState::new();
    let all_status = state.get_all_status();
    assert_eq!(all_status.len(), 0);
}

#[test]
fn test_session_status_thread_id_format() {
    let status = SessionStatus {
        id: "test".to_string(),
        connected: true,
        active: true,
        last_activity: 0,
        thread_id: "ThreadId(12345)".to_string(),
    };

    assert!(status.thread_id.starts_with("ThreadId"));
    assert!(status.thread_id.contains('('));
    assert!(status.thread_id.contains(')'));
}
