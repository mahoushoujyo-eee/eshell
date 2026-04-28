# Project Description

## Goal

eShell is a local-first desktop operations console designed to reduce context switching
between terminal tools and operational decision flows.

The project focuses on one integrated workflow:
- connect to hosts
- inspect runtime state
- perform file operations
- run commands/scripts
- use Ops Agent for guided actions and approvals

## Core Modules

- `src-tauri/src/server_ops`: shell, PTY, SFTP, status collection
- `src-tauri/src/storage`: persistent data (ssh/scripts/ai profiles)
- `src-tauri/src/ops_agent`: chat runtime, tool orchestration, approvals
- `src/hooks/useWorkbench.js`: frontend workspace state entry
- `src/hooks/workbench/*`: split workbench logic (operations/effects/session/errors)

## Current Scope

Implemented:
- SSH multi-session
- PTY terminal I/O
- cancellable SSH connection attempts during the TCP connection phase
- SFTP browse/read/write/create/delete/upload/download
- SFTP context-menu copy of absolute remote paths
- local download directory configuration
- transfer queue with progress updates
- upload/download cancel support
- status monitoring panel with disk / process view switching
- script management and execution
- Ops Agent chat and pending-action approval
- Ops Agent image upload, detached attachment persistence, and image preview
- Ops Agent manual and automatic conversation compaction
- Ops Agent run cancellation and post-approval resume flow
- English / Simplified Chinese UI switching with persisted locale preference
- richer Ops Agent debug logging for request, stream, and compaction diagnostics

Not in scope yet:
- encrypted credential storage
- resumable transfer after app restart
- RBAC / multi-user policy controls

## Data and State

Persistent data root:
- `.eshell-data/`

Important files:
- `ssh_configs.json`
- `scripts.json`
- `ai_profiles.json`
- `ops_agent_conversation_list.json`
- `ops_agent_conversations/*.json`
- `ops_agent_attachments/*`
- `ops_agent_debug.log`

Runtime-only state examples:
- active shell sessions
- PTY channels
- shell connection cancellation flags
- transfer cancellation flags
- status cache
- ops agent run registry and cancellation markers

## Frontend Localization

Current frontend copy is localized through `src/lib/i18n.js`.

Behavior:
- app boot chooses locale from `localStorage` (`eshell:locale`) when available
- otherwise locale falls back to the browser language
- current supported locales are `en-US` and `zh-CN`
- user-facing labels, modal copy, notices, and busy states should route through the shared translator

## SFTP Transfer Model

Current transfer model is chunk-based and event-driven:
- backend emits `sftp-transfer` events (`started`, `progress`, `completed`, `failed`, `cancelled`)
- frontend reduces events into a transfer queue for UI rendering
- user can cancel a running transfer from the transfer overlay

See [SFTP Transfer Guide](../guides/features/sftp_transfer.md).

## SSH Connection Cancellation

Opening a shell session accepts an optional `requestId`.
- frontend creates one request id per connect attempt
- `cancel_open_shell_session` marks that request id as cancelled
- backend checks the marker during the TCP connection loop
- once TCP is established, SSH handshake and password authentication use normal blocking `ssh2` behavior to preserve compatibility with servers that are sensitive to non-blocking handshakes

## Ops Agent Execution Model

Current Ops Agent behavior is event-driven and conversation-centric:
- chat runs stream over `ops-agent-stream`
- only one active run is allowed per conversation
- user turns may include shell context plus one or more image attachments
- image bytes are persisted separately from conversation JSON and referenced by attachment id
- risky shell actions become pending approvals instead of immediate failures
- approval resolution can resume the interrupted tool loop automatically
- long conversations may be compacted to stay inside `maxContextTokens`
- backend debug logs now capture request assembly, provider I/O summaries, stream deltas, and compaction decisions

See [Ops Agent Guide](../guides/features/ops_agent.md).

## Status Monitoring Notes

The status panel now prioritizes readability over raw density:
- top summary keeps CPU, memory, and network visible at all times
- lower detail area switches between `Processes` and `Disks`
- process memory is shown in `MB`
- overall memory remains `used / total` in `GB`

See [Server Status Guide](../guides/features/server_status.md).
