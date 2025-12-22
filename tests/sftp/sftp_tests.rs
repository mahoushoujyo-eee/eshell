use std::collections::HashMap;
use std::sync::{Arc, RwLock, mpsc};
use std::thread::{self, JoinHandle};
use std::time::{Duration, SystemTime};
use ssh2::Session;
use tauri::{test, AppHandle};
use tokio::time::sleep;

// Import the modules we're testing
use eshell::sftp::{SftpConfig, SftpSession, SftpFile, SftpOperation, list_files, download_file, upload_file, delete_file};
use eshell::ssh::{SshConfig, ShellSession, SessionStatus, ShellCommand, AppState, is_session_valid};

/// 创建一个测试用的SFTP配置
fn create_test_sftp_config() -> SftpConfig {
    SftpConfig {
        id: "test-sftp-123".to_string(),
        name: Some("Test SFTP Session".to_string()),
        host: "localhost".to_string(),
        port: 22,
        username: "testuser".to_string(),
        password: Some("testpass".to_string()),
        private_key: None,
        base_path: Some("/home/testuser".to_string()),
    }
}

/// 创建一个测试用的SFTP文件信息
fn create_test_sftp_file() -> SftpFile {
    SftpFile {
        name: "test_file.txt".to_string(),
        path: "/home/testuser/test_file.txt".to_string(),
        size: 1024,
        is_dir: false,
        is_file: true,
        is_symlink: false,
        modified: SystemTime::now(),
        accessed: SystemTime::now(),
        permissions: Some(0o644),
    }
}

/// 测试SFTP文件列表功能
#[tokio::test]
async fn test_sftp_list_files() {
    let state = AppState::new();
    let config = create_test_sftp_config();
    let session_id = config.id.clone();
    
    // 添加一个测试会话
    {
        let mut sessions = state.sessions.write().unwrap();
        sessions.insert(session_id.clone(), create_test_shell_session(true, true));
    }
    
    // 测试列出文件
    let result = list_files(tauri::State::new(state), session_id.clone(), "/".to_string()).await;
    
    // 由于没有实际的SFTP服务器，这应该失败
    // 但我们可以测试错误处理
    assert!(result.is_err());
    assert!(result.unwrap_err().contains("Session not found") || 
            result.unwrap_err().contains("SFTP") ||
            result.unwrap_err().contains("channel"));
}

/// 测试SFTP文件下载功能
#[tokio::test]
async fn test_sftp_download_file() {
    let state = AppState::new();
    let config = create_test_sftp_config();
    let session_id = config.id.clone();
    
    // 添加一个测试会话
    {
        let mut sessions = state.sessions.write().unwrap();
        sessions.insert(session_id.clone(), create_test_shell_session(true, true));
    }
    
    // 测试下载文件
    let result = download_file(
        tauri::State::new(state), 
        session_id.clone(), 
        "/home/testuser/test_file.txt".to_string(),
        "C:\\temp\\downloaded_file.txt".to_string()
    ).await;
    
    // 由于没有实际的SFTP服务器，这应该失败
    assert!(result.is_err());
}

/// 测试SFTP文件上传功能
#[tokio::test]
async fn test_sftp_upload_file() {
    let state = AppState::new();
    let config = create_test_sftp_config();
    let session_id = config.id.clone();
    
    // 添加一个测试会话
    {
        let mut sessions = state.sessions.write().unwrap();
        sessions.insert(session_id.clone(), create_test_shell_session(true, true));
    }
    
    // 测试上传文件
    let result = upload_file(
        tauri::State::new(state), 
        session_id.clone(), 
        "C:\\temp\\local_file.txt".to_string(),
        "/home/testuser/uploaded_file.txt".to_string()
    ).await;
    
    // 由于没有实际的SFTP服务器，这应该失败
    assert!(result.is_err());
}

/// 测试SFTP文件删除功能
#[tokio::test]
async fn test_sftp_delete_file() {
    let state = AppState::new();
    let config = create_test_sftp_config();
    let session_id = config.id.clone();
    
    // 添加一个测试会话
    {
        let mut sessions = state.sessions.write().unwrap();
        sessions.insert(session_id.clone(), create_test_shell_session(true, true));
    }
    
    // 测试删除文件
    let result = delete_file(
        tauri::State::new(state), 
        session_id.clone(), 
        "/home/testuser/test_file.txt".to_string()
    ).await;
    
    // 由于没有实际的SFTP服务器，这应该失败
    assert!(result.is_err());
}

/// 测试SFTP文件信息创建
#[test]
fn test_sftp_file_creation() {
    let file = create_test_sftp_file();
    
    assert_eq!(file.name, "test_file.txt");
    assert_eq!(file.path, "/home/testuser/test_file.txt");
    assert_eq!(file.size, 1024);
    assert!(!file.is_dir);
    assert!(file.is_file);
    assert!(!file.is_symlink);
    assert_eq!(file.permissions, Some(0o644));
}

/// 测试SFTP操作类型
#[test]
fn test_sftp_operations() {
    // 测试List操作
    let list_op = SftpOperation::List {
        session_id: "test-session".to_string(),
        path: "/home/testuser".to_string(),
    };
    
    match list_op {
        SftpOperation::List { session_id, path } => {
            assert_eq!(session_id, "test-session");
            assert_eq!(path, "/home/testuser");
        }
        _ => panic!("Expected List operation"),
    }
    
    // 测试Download操作
    let download_op = SftpOperation::Download {
        session_id: "test-session".to_string(),
        remote_path: "/home/testuser/file.txt".to_string(),
        local_path: "C:\\temp\\file.txt".to_string(),
    };
    
    match download_op {
        SftpOperation::Download { session_id, remote_path, local_path } => {
            assert_eq!(session_id, "test-session");
            assert_eq!(remote_path, "/home/testuser/file.txt");
            assert_eq!(local_path, "C:\\temp\\file.txt");
        }
        _ => panic!("Expected Download operation"),
    }
    
    // 测试Upload操作
    let upload_op = SftpOperation::Upload {
        session_id: "test-session".to_string(),
        local_path: "C:\\temp\\file.txt".to_string(),
        remote_path: "/home/testuser/file.txt".to_string(),
    };
    
    match upload_op {
        SftpOperation::Upload { session_id, local_path, remote_path } => {
            assert_eq!(session_id, "test-session");
            assert_eq!(local_path, "C:\\temp\\file.txt");
            assert_eq!(remote_path, "/home/testuser/file.txt");
        }
        _ => panic!("Expected Upload operation"),
    }
    
    // 测试Delete操作
    let delete_op = SftpOperation::Delete {
        session_id: "test-session".to_string(),
        path: "/home/testuser/file.txt".to_string(),
    };
    
    match delete_op {
        SftpOperation::Delete { session_id, path } => {
            assert_eq!(session_id, "test-session");
            assert_eq!(path, "/home/testuser/file.txt");
        }
        _ => panic!("Expected Delete operation"),
    }
}

/// 测试SFTP会话创建和验证
#[test]
fn test_sftp_session_validation() {
    let config = create_test_sftp_config();
    let session = create_test_shell_session(true, true);
    
    // 验证会话有效
    assert!(is_session_valid(&session));
    
    // 测试无效会话
    let invalid_session = create_test_shell_session(false, false);
    assert!(!is_session_valid(&invalid_session));
}

/// 测试并发SFTP操作
#[tokio::test]
async fn test_concurrent_sftp_operations() {
    let state = Arc::new(AppState::new());
    let config = create_test_sftp_config();
    let session_id = config.id.clone();
    
    // 添加一个测试会话
    {
        let mut sessions = state.sessions.write().unwrap();
        sessions.insert(session_id.clone(), create_test_shell_session(true, true));
    }
    
    let mut handles = vec![];
    
    // 创建多个并发SFTP操作
    for i in 0..5 {
        let state_clone = state.clone();
        let session_id_clone = session_id.clone();
        
        let handle = tokio::spawn(async move {
            // 尝试列出文件
            let result = list_files(
                tauri::State::new(state_clone), 
                session_id_clone, 
                format!("/home/testuser/dir{}", i)
            ).await;
            
            // 由于没有实际的SFTP服务器，这应该失败
            assert!(result.is_err());
        });
        
        handles.push(handle);
    }
    
    // 等待所有任务完成
    for handle in handles {
        handle.await.unwrap();
    }
}

/// 测试SFTP错误处理
#[tokio::test]
async fn test_sftp_error_handling() {
    let state = AppState::new();
    
    // 测试对不存在会话的操作
    let result = list_files(
        tauri::State::new(state), 
        "non-existent-session".to_string(), 
        "/".to_string()
    ).await;
    
    assert!(result.is_err());
    assert!(result.unwrap_err().contains("Session not found"));
    
    // 测试对无效会话的操作
    let state = AppState::new();
    let session_id = "invalid-session".to_string();
    
    // 添加一个无效会话
    {
        let mut sessions = state.sessions.write().unwrap();
        sessions.insert(session_id.clone(), create_test_shell_session(false, false));
    }
    
    let result = list_files(
        tauri::State::new(state), 
        session_id, 
        "/".to_string()
    ).await;
    
    assert!(result.is_err());
    assert!(result.unwrap_err().contains("not connected or inactive"));
}