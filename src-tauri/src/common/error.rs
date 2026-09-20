use thiserror::Error;

/// Application-level error used by core services and Tauri commands.
#[derive(Debug, Error)]
pub enum AppError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("JSON serialization error: {0}")]
    SerdeJson(#[from] serde_json::Error),
    /// Failure reported by the russh SSH transport (connection, handshake, auth, channel).
    #[error("SSH error: {0}")]
    SshTransport(#[from] russh::Error),
    /// Failure reported by the SFTP subsystem.
    #[error("SFTP error: {0}")]
    Sftp(#[from] russh_sftp::client::error::Error),
    #[error("HTTP client error: {0}")]
    Reqwest(#[from] reqwest::Error),
    #[error("base64 decode error: {0}")]
    Base64(#[from] base64::DecodeError),
    #[error("record not found: {0}")]
    NotFound(String),
    #[error("validation failed: {0}")]
    Validation(String),
    #[error("runtime error: {0}")]
    Runtime(String),
}

pub type AppResult<T> = Result<T, AppError>;

impl From<anyhow::Error> for AppError {
    fn from(value: anyhow::Error) -> Self {
        Self::Runtime(value.to_string())
    }
}

impl From<tauri::Error> for AppError {
    fn from(value: tauri::Error) -> Self {
        Self::Runtime(value.to_string())
    }
}

/// Converts AppError to command-friendly string payload.
pub fn to_command_error<E: Into<AppError>>(error: E) -> String {
    error.into().to_string()
}
