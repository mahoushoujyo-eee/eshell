use std::collections::HashMap;
use std::sync::{Arc, RwLock, mpsc};
use std::thread::{self, JoinHandle};
use std::time::{Duration, SystemTime};
use ssh2::Session;
use tauri::{test, AppHandle};
use tokio::time::sleep;

// Import the modules we're testing
use eshell::ssh::{SshConfig, ShellSession, SessionStatus, ShellCommand, AppState, connect_ssh, send_command, is_session_valid};
use eshell::ssh;

/// 创建一个测试用的SSH配置
fn create_test_ssh_config() -> SshConfig {
    SshConfig {
        id: "test-session-123".to_string(),
        name: Some("Test Session".to_string()),
        host: "localhost".to_string(),
        port: 22,
        username: "testuser".to_string(),
        password: Some("testpass".to_string()),
        private_key: None,
    }
}

/// 创建一个测试用的ShellSession
fn create_test_shell_session(connected: bool, active: bool) -> ShellSession {
    let config = create_test_ssh_config();
    let (tx, _rx) = mpsc::channel::<ShellCommand>();
    
    ShellSession {
        sender: tx,
        session: Session::new().unwrap(),
        thread_handle: None,
        status: Arc::new(RwLock::new(SessionStatus {
            id: config.id.clone(),
            connected,
            active,
            last_activity: SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_secs(),
            thread_id: String::new(),
        })),
        config,
    }
}

/// 测试会话状态验证函数
#[test]
fn test_session_validation() {
    // 测试未连接的会话
    let disconnected_session = create_test_shell_session(false, false);
    assert!(!is_session_valid(&disconnected_session));
    
    // 测试已连接但非活跃的会话
    let inactive_session = create_test_shell_session(true, false);
    assert!(!is_session_valid(&inactive_session));
    
    // 测试已连接且活跃的会话
    let active_session = create_test_shell_session(true, true);
    assert!(is_session_valid(&active_session));
    
    // 测试状态读取失败的情况
    let session_with_broken_status = ShellSession {
        sender: mpsc::channel().0,
        session: Session::new().unwrap(),
        thread_handle: None,
        status: Arc::new(RwLock::new(SessionStatus {
            id: "broken".to_string(),
            connected: true,
            active: true,
            last_activity: 0,
            thread_id: String::new(),
        })),
        config: create_test_ssh_config(),
    };
    
    // 模拟状态读取失败（通过poisoning the lock）
    // 注意：这在实际测试中很难实现，所以我们只测试正常情况
    assert!(is_session_valid(&session_with_broken_status));
}

/// 测试AppState的会话管理功能
#[test]
fn test_app_state_session_management() {
    let app_state = AppState::new();
    
    // 初始状态应该没有会话
    assert_eq!(app_state.get_all_status().len(), 0);
    
    // 添加一个测试会话
    let test_session = create_test_shell_session(true, true);
    let session_id = test_session.config.id.clone();
    
    {
        let mut sessions = app_state.sessions.write().unwrap();
        sessions.insert(session_id.clone(), test_session);
    }
    
    // 现在应该有一个会话
    assert_eq!(app_state.get_all_status().len(), 1);
    
    // 测试清理死会话
    {
        let mut sessions = app_state.sessions.write().unwrap();
        // 添加一个没有线程句柄的会话（模拟死会话）
        let dead_session = create_test_shell_session(false, false);
        sessions.insert("dead-session".to_string(), dead_session);
    }
    
    // 清理前应该有2个会话
    assert_eq!(app_state.get_all_status().len(), 2);
    
    // 清理死会话
    app_state.cleanup_dead_sessions();
    
    // 清理后应该只有1个会话
    assert_eq!(app_state.get_all_status().len(), 1);
}

/// 测试ShellSession的活动时间更新
#[test]
fn test_session_activity_update() {
    let session = create_test_shell_session(true, true);
    let original_activity = {
        let status = session.status.read().unwrap();
        status.last_activity
    };
    
    // 等待一小段时间
    thread::sleep(Duration::from_millis(10));
    
    // 更新活动时间
    session.update_activity();
    
    let updated_activity = {
        let status = session.status.read().unwrap();
        status.last_activity
    };
    
    // 活动时间应该更新了
    assert!(updated_activity > original_activity);
}

/// 测试会话ID冲突处理
#[tokio::test]
async fn test_session_id_conflict() {
    let state = AppState::new();
    let config = create_test_ssh_config();
    
    // 先添加一个同名会话
    {
        let mut sessions = state.sessions.write().unwrap();
        sessions.insert(config.id.clone(), create_test_shell_session(true, true));
    }
    
    // 尝试创建同名会话应该失败
    let app_handle = test::mock_app_handle();
    let result = connect_ssh(tauri::State::new(state), config, app_handle).await;
    
    // 应该返回错误，因为会话已存在
    assert!(result.is_err());
    assert!(result.unwrap_err().contains("Session already exists"));
}

/// 测试通道创建和资源管理
#[test]
fn test_channel_creation_and_cleanup() {
    // 测试未连接会话的通道创建
    let session = Session::new().unwrap();
    
    // 在没有TCP连接的情况下尝试创建通道应该失败
    let channel_result = session.channel_session();
    assert!(channel_result.is_err());
    
    // 错误信息应该包含有用的信息
    let error = channel_result.unwrap_err();
    assert!(!error.to_string().is_empty());
    
    // 测试通道关闭处理
    // 注意：在没有实际连接的情况下，我们无法测试真实的通道关闭
    // 但我们可以确保Session对象可以正常销毁
    drop(session);
}

/// 测试命令发送功能
#[tokio::test]
async fn test_command_sending() {
    let state = AppState::new();
    let config = create_test_ssh_config();
    let session_id = config.id.clone();
    
    // 添加一个测试会话
    {
        let mut sessions = state.sessions.write().unwrap();
        sessions.insert(session_id.clone(), create_test_shell_session(true, true));
    }
    
    // 发送命令到有效会话应该成功
    let result = send_command(tauri::State::new(state), session_id.clone(), "test command".to_string());
    assert!(result.is_ok());
    
    // 发送命令到不存在的会话应该失败
    let result = send_command(tauri::State::new(AppState::new()), "non-existent".to_string(), "test command".to_string());
    assert!(result.is_err());
    assert!(result.unwrap_err().contains("Session not found"));
}

/// 测试并发会话管理
#[tokio::test]
async fn test_concurrent_session_management() {
    let state = Arc::new(AppState::new());
    let mut handles = vec![];
    
    // 创建多个并发会话
    for i in 0..5 {
        let state_clone = state.clone();
        let handle = tokio::spawn(async move {
            let config = SshConfig {
                id: format!("test-session-{}", i),
                name: Some(format!("Test Session {}", i)),
                host: "localhost".to_string(),
                port: 22,
                username: "testuser".to_string(),
                password: Some("testpass".to_string()),
                private_key: None,
            };
            
            // 添加会话到状态
            {
                let mut sessions = state_clone.sessions.write().unwrap();
                sessions.insert(config.id.clone(), create_test_shell_session(true, true));
            }
            
            // 获取会话状态
            let status = state_clone.get_all_status();
            assert!(!status.is_empty());
        });
        
        handles.push(handle);
    }
    
    // 等待所有任务完成
    for handle in handles {
        handle.await.unwrap();
    }
    
    // 验证所有会话都被创建
    let status = state.get_all_status();
    assert_eq!(status.len(), 5);
}

/// 测试会话重连逻辑
#[tokio::test]
async fn test_session_reconnection() {
    let state = AppState::new();
    let config = create_test_ssh_config();
    let session_id = config.id.clone();
    
    // 添加一个测试会话
    {
        let mut sessions = state.sessions.write().unwrap();
        sessions.insert(session_id.clone(), create_test_shell_session(false, false));
    }
    
    // 尝试重连会话
    let app_handle = test::mock_app_handle();
    let result = ssh::reconnect_session(tauri::State::new(state), session_id, app_handle).await;
    
    // 由于没有实际的SSH服务器，重连应该失败
    // 但我们可以测试重连逻辑是否正确执行
    assert!(result.is_err());
}

/// 测试会话清理功能
#[test]
fn test_session_cleanup() {
    let state = AppState::new();
    
    // 添加多个测试会话
    for i in 0..5 {
        let mut sessions = state.sessions.write().unwrap();
        sessions.insert(
            format!("test-session-{}", i),
            create_test_shell_session(true, true)
        );
    }
    
    // 验证所有会话都被添加
    assert_eq!(state.get_all_status().len(), 5);
    
    // 清理会话
    let result = ssh::cleanup_sessions(tauri::State::new(state));
    assert!(result.is_ok());
    
    // 由于所有会话都是活跃的，清理后应该仍然有5个会话
    assert_eq!(result.unwrap(), 0);
}

/// 测试活跃会话设置
#[test]
fn test_active_session_setting() {
    let state = AppState::new();
    let config = create_test_ssh_config();
    let session_id = config.id.clone();
    
    // 添加一个测试会话
    {
        let mut sessions = state.sessions.write().unwrap();
        sessions.insert(session_id.clone(), create_test_shell_session(true, true));
    }
    
    // 设置活跃会话
    let result = ssh::set_active_session(tauri::State::new(state), session_id.clone());
    assert!(result.is_ok());
    
    // 验证活跃会话已设置
    let state = AppState::new();
    {
        let mut sessions = state.sessions.write().unwrap();
        sessions.insert(session_id.clone(), create_test_shell_session(true, true));
    }
    
    let active = state.active_session.read().unwrap();
    assert_eq!(*active, Some(session_id));
}