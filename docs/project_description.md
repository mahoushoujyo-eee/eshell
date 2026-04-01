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
- SFTP browse/read/write/upload/download
- local download directory configuration
- transfer queue with progress updates
- upload/download cancel support
- status monitoring panel
- script management and execution
- Ops Agent chat and pending-action approval

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

Runtime-only state examples:
- active shell sessions
- PTY channels
- transfer cancellation flags
- status cache

## SFTP Transfer Model

Current transfer model is chunk-based and event-driven:
- backend emits `sftp-transfer` events (`started`, `progress`, `completed`, `failed`, `cancelled`)
- frontend reduces events into a transfer queue for UI rendering
- user can cancel a running transfer from the transfer overlay

See [SFTP Transfer Guide](./sftp_transfer.md).
