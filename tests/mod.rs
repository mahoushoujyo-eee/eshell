// Test module for eshell
// This file organizes all test modules and provides common test utilities

pub mod ssh;
pub mod sftp;
pub mod monitor;

// Common test utilities and fixtures
use std::sync::{Arc, RwLock, mpsc};
use std::time::{Duration, SystemTime};
use ssh2::Session;

// Re-export common test utilities from submodules
pub use ssh::session_tests::*;
pub use sftp::sftp_tests::*;
pub use monitor::monitor_tests::*;

/// Common test configuration
pub struct TestConfig {
    pub test_host: String,
    pub test_port: u16,
    pub test_username: String,
    pub test_password: String,
    pub test_timeout: Duration,
}

impl Default for TestConfig {
    fn default() -> Self {
        Self {
            test_host: "localhost".to_string(),
            test_port: 22,
            test_username: "testuser".to_string(),
            test_password: "testpass".to_string(),
            test_timeout: Duration::from_secs(30),
        }
    }
}

/// Common test utilities
pub mod utils {
    use super::*;
    
    /// Create a mock SSH session for testing
    pub fn create_mock_session() -> Session {
        Session::new().unwrap()
    }
    
    /// Create a mock channel for testing
    pub fn create_mock_channel() -> Result<ssh2::Channel, ssh2::Error> {
        let session = create_mock_session();
        session.channel_session()
    }
    
    /// Wait for a condition to be true with timeout
    pub async fn wait_for_condition<F, Fut>(
        condition: F,
        timeout: Duration,
    ) -> Result<(), &'static str>
    where
        F: Fn() -> Fut,
        Fut: std::future::Future<Output = bool>,
    {
        let start = std::time::Instant::now();
        
        while start.elapsed() < timeout {
            if condition().await {
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        
        Err("Timeout waiting for condition")
    }
    
    /// Generate a unique test ID
    pub fn generate_test_id() -> String {
        format!("test-{}-{}", 
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_secs(),
            rand::random::<u32>()
        )
    }
}

/// Test macros for common test patterns
#[macro_export]
macro_rules! assert_error_contains {
    ($result:expr, $expected:expr) => {
        match $result {
            Ok(_) => panic!("Expected error containing '{}', but got Ok", $expected),
            Err(e) => assert!(
                e.to_string().contains($expected),
                "Expected error containing '{}', but got '{}'",
                $expected,
                e.to_string()
            ),
        }
    };
}

#[macro_export]
macro_rules! assert_session_valid {
    ($session:expr) => {
        assert!(
            $session.is_alive(),
            "Expected session to be alive"
        );
        assert!(
            eshell::ssh::is_session_valid($session),
            "Expected session to be valid"
        );
    };
}

#[macro_export]
macro_rules! assert_session_invalid {
    ($session:expr) => {
        assert!(
            !$session.is_alive(),
            "Expected session to be dead"
        );
        assert!(
            !eshell::ssh::is_session_valid($session),
            "Expected session to be invalid"
        );
    };
}