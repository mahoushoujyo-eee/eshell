# eShell

<p align="center">
  <img src="docs/Shell.png" alt="eShell Logo" width="180" />
</p>

eShell is a desktop operations workbench built with **Tauri 2 + React + Rust**.
It combines SSH, PTY terminal, SFTP file operations, server status monitoring,
script execution, and Ops Agent workflows in one application.

## Key Features

- Multi-session SSH management
- PTY terminal (`xterm.js`) with input and resize sync
- SFTP browser with:
  - directory tree and file preview/edit
  - upload/download
  - local download directory setting
  - transfer queue overlay with progress
  - manual transfer cancel (upload/download)
- Server status panel (CPU, memory, NIC, disk, top processes)
- Script center (save + execute in active session)
- Ops Agent:
  - conversation management
  - manual and automatic conversation compaction
  - streaming answer updates
  - pending action approval flow
  - automatic resume after action resolution
  - shell context attachment from terminal selection

## Recent SFTP Upgrade (2026-04)

- Added backend transfer event stream: `sftp-transfer`
- Added upload API with progress: `sftp_upload_file_with_progress`
- Added download-to-local API: `sftp_download_file_to_local`
- Added default local download dir API: `sftp_default_download_dir`
- Added transfer cancel API: `sftp_cancel_transfer`
- Added transfer status `cancelled`
- UI now uses a collapsible transfer overlay (next to `Refresh`) to avoid consuming panel space

## Tech Stack

Frontend:
- React 19
- Vite 7
- Tailwind CSS 4
- xterm.js
- Vitest

Backend:
- Tauri 2
- Rust
- ssh2
- reqwest
- serde / serde_json

## Project Structure

```text
src/
  components/
  hooks/
    useWorkbench.js
    workbench/
  lib/
  utils/

src-tauri/src/
  commands/
  server_ops/
  ops_agent/
  storage/
  models.rs
  state.rs
```

## Local Development

Prerequisites:
- Node.js >= 18
- Rust stable
- Tauri 2 prerequisites for your OS

Install:

```bash
npm install
```

Frontend dev:

```bash
npm run dev
```

Desktop app dev:

```bash
npm run tauri dev
```

Build:

```bash
npm run build
npm run tauri build
```

## Test and Validation

Frontend tests:

```bash
npm test
```

Rust checks:

```bash
cd src-tauri
cargo check
```

Rust tests:

```bash
cd src-tauri
cargo test
```

## Runtime Data

By default, runtime data is stored in `.eshell-data/` under the project root:

```text
.eshell-data/
  ssh_configs.json
  scripts.json
  ai_profiles.json
  ops_agent_conversation_list.json
  ops_agent_conversations/
  ops_agent_debug.log
```

## Documentation Index

- [Project Description](docs/project_description.md)
- [Project Dev Guide](docs/PROJECT_DEV_GUIDE.md)
- [Ops Agent Guide](docs/ops_agent.md)
- [OpenAPI-style RPC Spec](docs/openapi.yaml)
- [SFTP Transfer Guide](docs/sftp_transfer.md)
- [Release Notes 1.1.0](docs/releases/v1.1.0.md)
- [Reference Projects](docs/refer_proj/README.md)
