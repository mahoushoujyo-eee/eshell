## Why

eShell currently stores SSH profiles with password-only credentials and always authenticates through `userauth_password`, which prevents common operations environments from using key-only or passphrase-protected SSH access. It also does not prompt users to trust a new server's SSH host key fingerprint, so users cannot detect first-use identity changes or later host key mismatches. Adding key login plus host fingerprint trust makes SSH connection setup safer and closer to standard SSH client behavior.

## What Changes

- Add SSH profile fields for authentication type, private key path, optional passphrase, and optional password fallback.
- Update the SSH profile modal to let users choose password or key-based login and enter the fields required by that mode.
- Update backend storage models and persistence so existing password-only profiles continue to load and save correctly.
- Update SSH connection logic to authenticate with `ssh2` public-key APIs when key auth is selected, while preserving existing password authentication behavior.
- Add SSH host key fingerprint capture, first-connection trust confirmation, and mismatch blocking before credential authentication.
- Persist trusted host fingerprints locally so multiple profiles for the same host can share server identity trust.
- Improve validation and error messages for missing key paths, missing credentials, invalid auth mode, and authentication failures.
- Add focused Rust storage/connection tests and frontend tests around SSH form payloads and localized labels where practical.

## Capabilities

### New Capabilities
- `ssh-key-authentication`: SSH profiles can authenticate with private keys, optional key passphrases, existing password authentication remains supported, and SSH host fingerprints are verified through a local trust flow.

### Modified Capabilities

## Impact

- Frontend: `src/constants/workbench.js`, `src/components/sidebar/SshConfigModal.jsx`, `src/hooks/workbench/operations.js`, `src/lib/i18n.js`, and related tests.
- Backend: `src-tauri/src/models.rs`, `src-tauri/src/storage/ssh.rs`, `src-tauri/src/server_ops/service.rs`, and storage/connection tests.
- Data: `.eshell-data/ssh_configs.json` gains new optional credential fields; `.eshell-data/known_hosts.json` or equivalent local trust storage records host fingerprints; existing profiles without new fields must remain compatible.
- Security: private key passphrases and passwords remain local profile data; host key fingerprints are used to verify server identity; this change does not introduce encrypted credential storage.
