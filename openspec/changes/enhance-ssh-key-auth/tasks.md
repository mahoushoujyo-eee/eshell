## 1. Backend Model and Storage

- [x] 1.1 Add SSH authentication type modeling to `src-tauri/src/models.rs`, including serde defaults so legacy profiles without `authType` load as password auth.
- [x] 1.2 Extend `SshConfig` and `SshConfigInput` with `authType`, `privateKeyPath`, `privateKeyPassphrase`, and optional fallback fields while preserving existing `password` behavior.
- [x] 1.3 Add local known-host fingerprint models and storage, backed by `.eshell-data/known_hosts.json` or an equivalent local trust file keyed by host and port.
- [x] 1.4 Update `src-tauri/src/storage/ssh.rs` validation so password profiles require password credentials and private-key profiles require a private key path.
- [x] 1.5 Update Rust storage tests in `src-tauri/src/storage/tests.rs` for legacy password profiles, new private-key profiles, known-host persistence, and validation failures.

## 2. Backend Host Fingerprint Verification

- [x] 2.1 Refactor `src-tauri/src/server_ops/service.rs` so host key fingerprint verification runs after handshake and before password/private-key user authentication.
- [x] 2.2 Extract the SSH host key type and SHA256 fingerprint from the `ssh2::Session` host key data.
- [x] 2.3 Add backend commands or connection responses that let the frontend present unknown-host trust prompts and changed-fingerprint warnings without sending credentials first.
- [x] 2.4 Implement accept/reject/update flows for trusted host fingerprints, including blocking changed fingerprints until explicit replacement.
- [x] 2.5 Add actionable errors for rejected host trust, missing host key data, and fingerprint mismatches.

## 3. Backend SSH Authentication

- [x] 3.1 Refactor `src-tauri/src/server_ops/service.rs` to authenticate through a shared helper selected by `authType`.
- [x] 3.2 Implement private-key authentication with `ssh2::Session::userauth_pubkey_file`, passing the configured key path and optional passphrase.
- [x] 3.3 Add actionable error messages for missing/unreadable key files, invalid passphrases, unknown auth types, and failed authentication.
- [x] 3.4 Verify terminal, SFTP, status, and script execution paths continue using the shared verified `connect` / `connect_with_cancellation` flow.

## 4. Frontend SSH Profile and Host Trust UI

- [x] 4.1 Extend `EMPTY_SSH` in `src/constants/workbench.js` with the new credential fields and password-compatible defaults.
- [x] 4.2 Update `src/components/sidebar/SshConfigModal.jsx` with an authentication mode control and conditional password/private-key fields.
- [x] 4.3 Update `src/hooks/workbench/operations.js` so saved SSH profile payloads include the selected auth mode and credential fields.
- [x] 4.4 Add a blocking host fingerprint confirmation UI for unknown hosts and a stronger mismatch warning UI for changed fingerprints.
- [x] 4.5 Add `en-US` and `zh-CN` translations in `src/lib/i18n.js` for all new auth mode labels, field labels, host trust prompts, warnings, hints, and validation copy.

## 5. Verification

- [x] 5.1 Run `npm run test` and fix any frontend/unit regressions.
- [x] 5.2 Run `cargo test` in `src-tauri` and fix any Rust regressions.
- [x] 5.3 Manually inspect or smoke-test the SSH profile modal to confirm password and private-key modes render correctly.
- [ ] 5.4 Manually inspect or smoke-test unknown-host trust, trusted-host reconnect, rejected-host abort, and changed-fingerprint blocking flows.
- [x] 5.5 Run `npx @fission-ai/openspec@latest validate --all` and confirm the change remains valid.
