## Context

eShell stores SSH profiles in `.eshell-data/ssh_configs.json` through `SshConfig` / `SshConfigInput`. The current model only contains `password`, the profile modal only renders a password field, and `connect_with_cancellation` always authenticates with `session.userauth_password(&config.username, &config.password)`.

The current connection flow also does not persist or verify the SSH server host key fingerprint. Standard SSH clients use this fingerprint to confirm server identity: credentials prove the user to the server, while the host key proves the server to the user. The new SSH security flow therefore spans frontend form state, persisted profile shape, local known-host trust storage, backend validation, and the SSH connection path used by terminal, SFTP, status monitoring, and script execution. It must remain local-first and backwards compatible with existing password-only profiles.

## Goals / Non-Goals

**Goals:**
- Support password auth and private-key auth as explicit SSH profile modes.
- Allow key auth with an optional passphrase for encrypted private keys.
- Preserve existing profiles that only contain `password`.
- Keep credential handling local to existing profile storage and connection code.
- Verify SSH server host key fingerprints before user authentication.
- Prompt users to trust unknown host fingerprints and block changed fingerprints until explicitly resolved.
- Surface actionable validation/authentication errors in both frontend and backend paths.

**Non-Goals:**
- Encrypted credential storage or OS keychain integration.
- SSH agent forwarding or automatic use of `ssh-agent`.
- Public key generation, key upload to remote hosts, or server-side SSH configuration.
- Importing OpenSSH config files.
- Full OpenSSH `known_hosts` parser compatibility.
- Automatic host key rotation policies beyond explicit user confirmation.

## Decisions

1. Add an explicit `authType` field with `"password"` and `"privateKey"` values.

   Rationale: an explicit mode avoids guessing based on which credential fields are non-empty and makes the UI, validation, and future extensions clearer. Existing profiles without `authType` will deserialize/default to password mode.

   Alternative considered: infer key auth when `privateKeyPath` is present. This is less predictable when users keep both password and key fields for fallback.

2. Persist key material by path, not by private key contents.

   Rationale: key files already live on the user's machine and `ssh2::Session::userauth_pubkey_file` accepts key paths. Storing file contents in `ssh_configs.json` would increase secret exposure and complicate editing.

   Alternative considered: store pasted private key text. This may be useful later but is riskier and unnecessary for the requested public/private key login workflow.

3. Keep optional `password` available for password auth and optional fallback, and add `privateKeyPassphrase` for encrypted key files.

   Rationale: passphrases are distinct from account passwords and map directly to `ssh2` public-key authentication. Keeping password fallback optional lets users recover when a server supports both methods without creating duplicate profiles.

   Alternative considered: replace `password` with one generic `secret` field. That would make persisted data ambiguous and increase migration risk.

4. Centralize backend authentication in a helper called by `connect_with_cancellation`.

   Rationale: all terminal, SFTP, status, and script flows already share `connect` / `connect_with_cancellation`; adding an `authenticate_session` helper keeps behavior consistent and testable without touching every caller.

5. Store trusted host fingerprints in a local known-hosts store keyed by host and port, not inside individual SSH profiles.

   Rationale: server identity is a property of the remote endpoint. A user may create multiple profiles for the same host with different usernames or auth modes, and they should share the same trust decision.

   Alternative considered: store the trusted fingerprint on each profile. This is simpler but creates duplicated trust records and inconsistent behavior when one host is accessed through multiple profiles.

6. Verify host key fingerprints after SSH handshake and before password/private-key user authentication.

   Rationale: `ssh2` exposes the server host key after handshake. Checking it before sending credentials ensures eShell does not disclose passwords or attempt private-key authentication to an untrusted or changed server identity.

   Alternative considered: authenticate first, then verify the host key. This is easier to wire into the current flow but weakens the security property because credentials are already offered.

7. Treat unknown host fingerprints and changed host fingerprints as different UI states.

   Rationale: first-use trust is a normal SSH workflow and can be confirmed by the user. A changed fingerprint is higher risk and should be blocked with stronger wording, requiring explicit replacement of the saved trust record.

   Alternative considered: use one generic confirmation for both cases. That risks normalizing a possible man-in-the-middle warning.

## Risks / Trade-offs

- Private key path becomes stale after moving files -> validate path existence/readability before authentication and return an actionable message.
- Existing JSON profiles lack new fields -> add serde defaults and storage update logic that preserves compatibility.
- Optional password fallback can mask key misconfiguration -> only use fallback when explicitly enabled or when the profile is in password mode; key-auth failures should be visible by default.
- Passphrases remain stored in local JSON if saved -> document this as unchanged local profile storage and keep encrypted credential storage out of scope for this change.
- First-use trust can still trust the wrong host if the user accepts without checking -> show host, port, key type, and SHA256 fingerprint clearly, and explain that the value should match the server's expected fingerprint.
- Some legitimate server rebuilds rotate host keys -> provide a deliberate replacement flow for changed fingerprints instead of silently updating trust.

## Migration Plan

1. Extend models with defaults so existing profiles deserialize as password auth with empty key fields.
2. Add local known-host storage with an empty initial trust set.
3. Update the profile form defaults and save payloads to include the new auth fields.
4. Update backend validation, host fingerprint verification, and connection authentication.
5. Add tests for legacy password profiles, key-auth profile persistence, host trust decisions, validation, and connection helper behavior where practical.
6. Rollback is deleting the new fields from form/model usage and leaving existing `password` behavior intact; profiles with new fields and known-host entries should remain harmless if ignored by older code.

## Open Questions

- Should password fallback be a visible checkbox in the first implementation, or should users create a separate password profile if key auth fails?
- Should file picking for private keys use a Tauri dialog immediately, or start with a path text field and add a picker later?
- Should the first implementation expose host fingerprint trust as a blocking modal in the SSH connect flow, or as a pending approval-style notice in the existing connection panel?
