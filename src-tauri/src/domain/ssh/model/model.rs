//! SSH connection profiles, authentication and host-key trust.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SshAuthType {
    Password,
    PrivateKey,
    KeyboardInteractive,
}

pub fn default_ssh_auth_type() -> SshAuthType {
    SshAuthType::Password
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SshConfig {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    #[serde(default = "default_ssh_auth_type")]
    pub auth_type: SshAuthType,
    #[serde(default)]
    pub password: String,
    #[serde(default)]
    pub private_key_path: String,
    #[serde(default)]
    pub private_key_passphrase: String,
    #[serde(default)]
    pub use_password_fallback: bool,
    #[serde(default)]
    pub jump_host_id: Option<String>,
    pub description: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConfigInput {
    pub id: Option<String>,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    #[serde(default = "default_ssh_auth_type")]
    pub auth_type: SshAuthType,
    #[serde(default)]
    pub password: String,
    #[serde(default)]
    pub private_key_path: String,
    #[serde(default)]
    pub private_key_passphrase: String,
    #[serde(default)]
    pub use_password_fallback: bool,
    #[serde(default)]
    pub jump_host_id: Option<String>,
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshKiPromptItem {
    pub text: String,
    pub echo: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshKiPromptEvent {
    pub request_id: String,
    pub username: String,
    pub instructions: String,
    pub prompts: Vec<SshKiPromptItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshKiRespondInput {
    pub request_id: String,
    pub responses: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SshKnownHost {
    pub host: String,
    pub port: u16,
    pub key_type: String,
    pub fingerprint: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrustSshHostKeyInput {
    pub host: String,
    pub port: u16,
    pub key_type: String,
    pub fingerprint: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshHostKeyTrustChallenge {
    pub reason: SshHostKeyTrustReason,
    pub host: String,
    pub port: u16,
    pub key_type: String,
    pub fingerprint: String,
    pub trusted_fingerprint: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SshHostKeyTrustReason {
    Unknown,
    Changed,
}
