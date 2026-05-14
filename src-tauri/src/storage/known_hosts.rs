use crate::error::{AppError, AppResult};
use crate::models::{now_rfc3339, SshKnownHost, TrustSshHostKeyInput};

use super::io::write_json_pretty;
use super::Storage;

impl Storage {
    /// Returns the trusted SSH host key for a host and port, if one is stored.
    pub fn find_known_host(&self, host: &str, port: u16) -> Option<SshKnownHost> {
        let normalized_host = normalize_known_host(host);
        self.known_hosts
            .read()
            .expect("known hosts lock poisoned")
            .iter()
            .find(|item| item.host == normalized_host && item.port == port)
            .cloned()
    }

    /// Trusts or replaces the host key fingerprint for a host and port.
    pub fn trust_ssh_host_key(&self, input: TrustSshHostKeyInput) -> AppResult<SshKnownHost> {
        let host = normalize_known_host(&input.host);
        let key_type = input.key_type.trim().to_string();
        let fingerprint = input.fingerprint.trim().to_string();

        if host.is_empty() {
            return Err(AppError::Validation("host cannot be empty".to_string()));
        }
        if input.port == 0 {
            return Err(AppError::Validation("port must be in 1-65535".to_string()));
        }
        if key_type.is_empty() {
            return Err(AppError::Validation("host key type cannot be empty".to_string()));
        }
        if fingerprint.is_empty() {
            return Err(AppError::Validation(
                "host key fingerprint cannot be empty".to_string(),
            ));
        }

        let now = now_rfc3339();
        let mut guard = self.known_hosts.write().expect("known hosts lock poisoned");
        let record = match guard
            .iter()
            .position(|item| item.host == host && item.port == input.port)
        {
            Some(index) => {
                let existing = &guard[index];
                let updated = SshKnownHost {
                    host,
                    port: input.port,
                    key_type,
                    fingerprint,
                    created_at: existing.created_at.clone(),
                    updated_at: now,
                };
                guard[index] = updated.clone();
                updated
            }
            None => {
                let created = SshKnownHost {
                    host,
                    port: input.port,
                    key_type,
                    fingerprint,
                    created_at: now.clone(),
                    updated_at: now,
                };
                guard.push(created.clone());
                created
            }
        };

        write_json_pretty(&self.known_hosts_path, &*guard)?;
        Ok(record)
    }
}

fn normalize_known_host(host: &str) -> String {
    host.trim().to_ascii_lowercase()
}
