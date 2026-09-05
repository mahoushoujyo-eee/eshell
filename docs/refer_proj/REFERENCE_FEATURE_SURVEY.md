# Reference Feature Survey For EShell

This note is a second-pass feature survey of Termora, Electerm, Tabby, and the Claude Code architecture notes under `docs/refer_proj`. It focuses on learnable product and architecture patterns rather than implementation copying.

## High-Signal Learnings

### 1. PTY Backpressure Should Be Explicit

Tabby's `PTYDataQueue` does more than throttle terminal output. It tracks unacknowledged bytes, pauses the underlying PTY when buffered output is too far ahead, resumes after renderer acknowledgement, and preserves UTF-8 boundaries through a splitter.

EShell currently has batching and non-blocking reads in the Rust PTY worker, but the frontend write path is still mostly push-only. A future EShell improvement should add an acknowledgement or bounded queue between `pty-output` events and xterm writes:

- Backend emits chunks with byte length and monotonic sequence.
- Frontend acknowledges after `terminal.write()` drains.
- Backend pauses or coalesces output when pending bytes exceed a threshold.
- UTF-8 splitting remains backend-side or is handled before xterm write.

This is more valuable than simply changing sleep intervals, because it turns terminal output into a flow-controlled channel.

### 2. Login Scripts Are A Small Feature With Large Daily Value

Termora and Tabby both model login scripts as ordered `{ expect, send }` steps. Tabby also supports regex matching, optional steps, unconditional commands, and escape sequence expansion.

EShell already has saved scripts, but those are manual actions after a session is open. A focused "login scripts" extension would fit naturally into `SshConfig`:

- Store ordered rules on each SSH config.
- Rule fields: `expect`, `send`, `isRegex`, `optional`.
- PTY worker observes output and sends matching `send + "\n"` into the existing PTY input channel.
- Unconditional rules run after shell open.

This should be implemented conservatively, with a visible per-session indicator or log entry, because automatic command sending can surprise users.

### 3. Transfer Queue Should Become A Real Job Model

Termora's transfer table is a tree, not a flat list. Directory transfers are parent jobs with child file jobs; each node tracks state, total bytes, transferred bytes, speed, and estimated time. Electerm adds pause/resume and a history list.

EShell already has a lightweight transfer queue, but folder transfers and multi-file operations will strain a flat "latest event wins" model. Before implementing folder upload/download deeply, define a job model:

- Job id, parent id, direction, source, target, kind: file/directory/delete/chmod.
- State: queued, scanning, running, paused, completed, failed, cancelled.
- Aggregates: total files, completed files, total bytes, transferred bytes, bytes/sec.
- Event schema remains compatible with current `sftp-transfer`, but can include optional `parentTransferId` and counts.

This lets P1.1 folder upload/download, P1.3 multi-select, and future pause/resume share one foundation.

### 4. File Conflict Policy Needs First-Class UX

Termora has conflict handling with overwrite/skip and "apply to all"; Electerm has a transfer `resolvePolicy`. This matters once folders and multi-select transfers exist.

Recommended EShell policy:

- Default: ask on conflict for manual file manager actions.
- Options: overwrite, skip, rename, cancel.
- "Apply to all" for batch/folder transfers.
- Persist only for the current transfer batch, not globally.

Backend commands should accept an explicit policy so retries are deterministic and tests can cover behavior without UI dialogs.

### 5. Quick Commands And Scripts Should Converge

Electerm's quick commands are closer to "operator snippets": they have labels, search, multi-command entries, per-host quick commands, and MCP exposure. EShell's saved scripts are already more structured than a plain snippet because parameters exist, but the UI can learn from quick commands:

- Add labels/tags and search to `ScriptConfigModal`.
- Support multi-step scripts as an ordered list, while keeping the current single `command` path.
- Allow pinning a script to a host config or session toolbar.
- Record last run time and recent outputs/errors.

This turns scripts from a settings modal into a daily workflow surface.

### 6. Bookmarks Are More Than Saved SSH Configs

Electerm treats bookmarks as a tree of connection objects and exposes them to MCP-style automation. Termora uses path bookmarks inside the SFTP panel. EShell has SSH configs but no SFTP path bookmarks.

Near-term EShell path:

- Add remote path bookmarks scoped to `config_id` or `session_id`.
- Add directory history/back/forward in SFTP.
- Add "open path" command palette item.

This is lower risk than a full local/remote dual-pane rewrite and fits the existing tree + entries layout.

### 7. Port Forwarding Can Be A Session Tool, Not Only A Config Tab

Tabby supports adding/removing port forwards after connection through a modal. Termora and Electerm lean more on saved connection configuration.

For EShell, dynamic session-level forwarding is the better first slice:

- Add Tauri commands: start local forward, stop forward, list forwards.
- Store active forwards in `AppState`, keyed by shell session.
- Surface a compact "Forwards" panel from the current SSH session.
- Later add saved forward definitions to `SshConfig`.

This avoids overloading the SSH config modal before the runtime behavior is proven.

### 8. Configuration Sync Should Be Partial And Explicit

Tabby lets users sync config parts selectively; Termora's sync code also scopes ranges such as hosts, key pairs, and keyword highlights. Both avoid "all settings or nothing".

EShell should avoid cloud sync until secrets handling is stronger, but the data model lesson is useful now:

- Split export/import into explicit ranges: SSH configs, scripts, AI profiles, known hosts, UI preferences.
- Redact or separately encrypt secrets.
- Include schema version and app version in exported bundles.

This also sets up safer bug reports and migrations.

### 9. Plugin Architecture Should Start As Extension Points

Tabby has full package-based plugins; Termora exposes action/window/provider extensions. EShell does not need a broad plugin marketplace yet. It can still adopt extension boundaries internally:

- SFTP context menu item provider.
- Status panel metric provider.
- Script runner provider.
- AI tool provider.

Even if all providers are internal at first, these interfaces keep future features from becoming one giant switch statement.

### 10. Claude Code Notes Are Most Relevant To EShell's AI Panel

The Claude Code architecture notes are not SSH-client references, but several ideas map directly to EShell's existing ops-agent:

- Tool permissions should remain explicit and auditable.
- Long conversations need compaction and project/session memory.
- Task state should be visible, not hidden inside model text.
- File edits should prefer atomic writes and verifiable diffs.
- Hooks/skills/MCP are useful as controlled extension surfaces, not as unrestricted automation.

EShell already has pending actions and split conversation storage, so the next valuable AI-side improvements are context budget visibility, session memory summaries, and tool-level audit history.

## Suggested Roadmap Additions

### Near-Term

1. Add SFTP folder upload/download on top of the current streaming upload and transfer event system.
2. Extend transfer events with optional job hierarchy fields before adding folder transfer UI.
3. Add SFTP path history and path bookmarks.
4. Add script search, labels, and per-host pinned scripts.
5. Add basic login scripts with conservative visible logging.

### Mid-Term

1. Add PTY output backpressure with frontend acknowledgements.
2. Add file conflict policies for transfer batches.
3. Add session-level local port forwarding.
4. Add transfer speed and ETA to the queue.
5. Add SSH config import/export with secret redaction.

### Later

1. Add partial encrypted config sync.
2. Add a local/remote dual-pane file manager mode.
3. Add plugin-style internal provider interfaces.
4. Add terminal keyword highlighting and theme management.
5. Add GPU monitoring and protocol extras such as X11/ZModem only if user demand appears.

## Implementation Guardrails

- Prefer small slices that attach to existing EShell surfaces: SFTP panel, Scripts modal, Status panel, AI assistant.
- Do not import reference project code; use behavior and architecture patterns only.
- Avoid broad plugin architecture until internal extension points stabilize.
- Treat automation features such as login scripts and batch ops as potentially dangerous: make actions visible and cancellable.
- Keep large transfer work stream-based and resumable in design, even if the first version only supports cancel.
