# eShell

<p align="center">
  <img src="docs/assets/Shell.png" alt="eShell Logo" width="180" />
</p>

**v1.3.2** — Desktop operations workbench built with **Tauri 2 + React + Rust**.

eShell combines SSH, PTY terminal, SFTP file operations, server status monitoring,
script execution, and Ops Agent workflows in one integrated application.

## Key Features

- **Multi-session SSH management** — configure and switch between multiple SSH profiles
- **PTY terminal** (`xterm.js`) with input and resize sync; customizable wallpaper (built-in presets or custom upload with crop)
- **Light / Dark theme toggle** from the sidebar
- **English / Simplified Chinese UI** with persisted locale preference (`eshell:locale`)
- **SFTP browser**:
  - directory tree and file preview / edit
  - upload and download with real-time progress
  - configurable local download directory
  - collapsible transfer queue overlay (direction, stage, progress, cancel)
  - manual upload / download cancel
- **Server status panel** — CPU, memory, network traffic, plus a switchable Processes / Disks detail view
- **Script center** — save and execute scripts in the active session
- **Platform-adaptive title bar** — macOS traffic-light controls on macOS; standard minimize / maximize / close on Windows and Linux
- **Ops Agent**:
  - conversation management (create, switch, delete)
  - conversation-level approval mode (`Approval` / `Full Access`)
  - streaming assistant replies via `ops-agent-stream`
  - pending action approval flow for risky shell commands
  - automatic ReAct loop resume after approval resolution
  - manual and automatic conversation compaction
  - shell context attachment from terminal selection
  - image upload with multimodal model input
  - click-to-view image tags on sent user messages
  - debug logging in `.eshell-data/ops_agent_debug.log`

## Tech Stack

**Frontend:**
- React 19
- Vite 7
- Tailwind CSS 4
- xterm.js
- Vitest

**Backend:**
- Tauri 2
- Rust
- ssh2
- reqwest
- serde / serde_json

## Project Structure

```text
src/
  components/
    app/           # workspace shell, AI dock, modals
    layout/        # title bar, top toolbar, notice stack
    panels/        # terminal, SFTP, status, AI assistant, file editor
    sidebar/       # SSH / script / AI / wallpaper config modals
  constants/
    workbench.js   # wallpaper presets, panel constants
  hooks/
    useWorkbench.js
    workbench/     # operations, effects, session, errors, aiProfiles
  lib/
    i18n.js        # English / Simplified Chinese localization
    tauri-api.js   # frontend invoke wrappers
    sftp-transfer.js
    ops-agent-stream.js
    ops-agent-message-rendering.js
    ops-agent-shell-context.js

src-tauri/src/
  commands/
  server_ops/      # shell, PTY, SFTP, status collection
  ops_agent/       # chat runtime, tool orchestration, approvals, compaction
  storage/         # persistent data (ssh / scripts / ai profiles)
  models.rs
  state.rs
```

## Local Development

**Prerequisites:**
- Node.js >= 18
- Rust stable
- Tauri 2 prerequisites for your OS

**Install:**

```bash
npm install
```

**Frontend dev:**

```bash
npm run dev
```

**Desktop app dev:**

```bash
npm run tauri dev
```

**Build:**

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

Runtime data is stored in `.eshell-data/` under the project root:

```text
.eshell-data/
  ssh_configs.json
  scripts.json
  ai_profiles.json
  ops_agent_conversation_list.json
  ops_agent_conversations/
  ops_agent_attachments/
  ops_agent_debug.log
```

## Documentation Index

- [Docs Overview](docs/README.md)
- [Project Description](docs/specs/project_description.md)
- [Project Dev Guide](docs/guides/PROJECT_DEV_GUIDE.md)
- [Ops Agent Guide](docs/guides/features/ops_agent.md)
- [Ops Agent Layered Architecture](docs/guides/architecture/ops_agent_layered_architecture.md)
- [OpenAPI-style RPC Spec](docs/specs/openapi.yaml)
- [Server Status Guide](docs/guides/features/server_status.md)
- [SFTP Transfer Guide](docs/guides/features/sftp_transfer.md)
- [Unreleased Notes](docs/releases/unreleased.md)
- [Release Notes 1.3.0](docs/releases/v1.3.0.md)
- [Release Notes 1.2.0](docs/releases/v1.2.0.md)
- [Reference Projects](docs/refer_proj/README.md)
