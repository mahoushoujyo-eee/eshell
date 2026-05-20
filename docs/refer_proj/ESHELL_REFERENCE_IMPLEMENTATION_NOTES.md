# EShell Reference Implementation Notes

This note records implementation lessons from Termora, Electerm, and Tabby that are directly actionable for EShell. It complements `COMPARATIVE_ANALYSIS.md` with decisions tied to the current Tauri + Rust + React codebase.

## Adopted Patterns

### SSH Operation Session Reuse

Termora's `SshSessionPool` and Tabby's `SSHMultiplexerService` both avoid repeated authentication by sharing an established SSH session across shell, SFTP, and exec-style work. EShell now follows the same principle for non-PTY operations:

- PTY keeps its own long-lived shell connection because `ssh2::Session` is not safe to use concurrently without serialization.
- SFTP and status queries share one per-`session_id` operation connection stored in `AppState`.
- Access is guarded by `Arc<Mutex<ssh2::Session>>`, so libssh2 operations stay serialized.
- Closing a shell session removes its cached operation connection.

This avoids the previous TCP + SSH handshake for every SFTP operation and every status refresh.

### Local-Path Uploads Instead Of Base64 Payloads

Tabby and Electerm do not load whole files into renderer memory for normal SFTP uploads. Their desktop platforms return local file paths or file stream handles, and the transfer layer reads chunks from disk.

EShell now uses the same boundary for toolbar uploads:

- Frontend selects a local path with a native desktop dialog.
- Tauri command receives `{ sessionId, remotePath, localPath, transferId }`.
- Rust opens `std::fs::File` and streams chunks into the remote SFTP file.
- Existing `sftp-transfer` events remain the progress surface.

The legacy base64 upload command stays temporarily for compatibility, but toolbar uploads now use local-path streaming.

### Transfer Progress Throttling

Electerm throttles transfer progress updates and Tabby uses buffered stream primitives. EShell previously emitted progress every 64 KiB chunk, which could flood the frontend for large files.

Implemented EShell rule:

- Emit `started`, `failed`, `cancelled`, and `completed` immediately.
- Emit `progress` no more often than every 200 ms.
- Always emit `completed` with the exact final byte count.

### Atomic Remote Writes

Tabby's upload implementation writes to a temporary remote path and renames it into place after the write succeeds. EShell now applies the same pattern to editor saves:

- Write a target sibling temp file such as `.<name>.eshell-tmp-<uuid>`.
- Close the remote file handle.
- Rename temp path to target path.
- On failure, unlink the temp path best-effort.

This prevents interrupted saves from truncating the target file.

## Deferred Patterns

### Full Reference-Counted Session Pool

Termora and Tabby support ref/unref semantics across multiple tabs and auxiliary tools. EShell's current per-shell-session operation connection is intentionally smaller:

- It fixes repeated SFTP/status handshakes now.
- It avoids cross-tab ownership complexity.
- It leaves room for a future profile-level pool if EShell adds cloned tabs or cross-window sharing.

### High-Concurrency Chunk Transfer

Electerm's `fastXfer()` manages many concurrent SFTP read/write requests. EShell should defer this until after local-path streaming, folder transfers, and progress throttling are stable. `ssh2` crate ergonomics are different from Node ssh2, so copying the concurrency model directly would add risk.

### Full Dual-Pane Local File Manager

Termora and Electerm both have mature local/remote dual panes. EShell's current tree + list layout is good for remote browsing, so the near-term path is:

1. Native file/folder picker for upload/download targets.
2. Drag-and-drop upload.
3. Optional local pane later if repeated local navigation becomes important.

## Current Priority Mapping

| Priority | EShell task | Reference influence |
| --- | --- | --- |
| P0.1 | SSH operation connection reuse | Termora `SshSessionPool`, Tabby multiplexer |
| P0.2 | Upload without base64 | Tabby/Electerm desktop file upload APIs |
| P1.1 | Folder upload/download | Termora transfer scanner, Tabby recursive upload |
| P2.2 | Progress throttling | Electerm throttled `onData` |
| P2.3 | Atomic writes | Tabby `.tabby-upload` temp + rename |

## Implementation Guardrails

- Keep PTY connection ownership separate from SFTP/status operations.
- Do not hold frontend file bytes in JS state for SFTP upload.
- Keep legacy commands until all UI callers have moved to streaming commands.
- Preserve current `sftp-transfer` event schema so the React transfer queue does not need a broad rewrite.
- Add focused Rust tests around pure helpers and AppState lifecycle; live SSH tests remain manual/integration-level.
