# eShell

<p align="center">
  <img src="docs/assets/Shell.png" alt="eShell Logo" width="180" />
</p>

**eShell v1.4.0** is a desktop operations workbench built with **Tauri 2, React 19, and Rust**.

It combines SSH sessions, PTY terminals, SFTP file operations, server status monitoring, reusable scripts, and an Ops Agent for AI-assisted operations in one local-first application.

[中文说明](README.zh-CN.md)

## What It Does

- Manage multiple SSH profiles and switch active sessions quickly.
- Use an interactive `xterm.js` PTY terminal with resize sync and custom wallpaper.
- Browse, preview, edit, upload, download, and delete files through SFTP.
- Monitor remote server CPU, memory, network traffic, processes, and disks.
- Save reusable scripts and run them against the active session.
- Chat with an Ops Agent that can inspect context, propose commands, request approval, and resume after approvals.
- Configure multiple AI provider profiles for OpenAI Chat Completions, OpenAI Responses, and Anthropic Messages compatible APIs.
- Use English or Simplified Chinese UI with persisted locale preference.

## Ops Agent Highlights

The Ops Agent is the main AI subsystem under `src-tauri/src/ops_agent/`.

- Runtime gateway chooses `direct_reply`, `lite`, or `pro`.
- `direct_reply` answers simple chat/API smoke-test messages without planner or ReAct overhead.
- `lite` runs a compact ReAct loop for simple tool-assisted work.
- `pro` runs planner, executor, reviewer, validator, and final-answer stages.
- Risky shell actions create pending approvals instead of executing silently.
- Approval resolution can resume the interrupted run automatically.
- Long conversations use non-destructive model-context compaction:
  - visible chat history stays unchanged
  - private summaries are stored under `.eshell-data/ops_agent_context_summaries/`
  - repeated compaction rolls the prior summary forward with newer raw messages
- Image attachments are stored separately and rehydrated into multimodal model requests.

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

## Project Layout

```text
src/
  components/
    ai/            # provider icons and shared AI UI
    app/           # app shell, AI dock, modal composition
    layout/        # title bar, toolbar, notices
    panels/        # terminal, SFTP, status, AI assistant, file editor
    sidebar/       # SSH / script / AI / wallpaper settings
  hooks/
    useWorkbench.js
    workbench/     # sessions, operations, effects, errors, AI profiles
  lib/
    tauri-api.js
    ops-agent-stream.js
    ops-agent-message-rendering.js
    ops-agent-shell-context.js
    sftp-transfer.js
    i18n.js

src-tauri/src/
  commands/        # Tauri command entry points
  server_ops/      # SSH, PTY, SFTP, status collection
  ops_agent/       # runtime gateway, agents, providers, tools, approvals, compaction
  storage/         # persisted SSH / scripts / AI profiles / AGENTS.md context
  models.rs
  state.rs

docs/
  guides/
  specs/
  releases/
  reports/
  prompts/
  refer_proj/
```

## Local Development

Prerequisites:

- Node.js 18+
- Rust stable
- Tauri 2 system prerequisites for your OS

Install dependencies:

```bash
npm install
```

Run frontend only:

```bash
npm run dev
```

Run desktop app:

```bash
npm run tauri dev
```

Build:

```bash
npm run build
npm run tauri build
```

## Test And Validation

Frontend tests:

```bash
npm test
```

Rust checks:

```bash
cd src-tauri
cargo check
```

Rust test build:

```bash
cd src-tauri
cargo test --no-run
```

Full Rust tests:

```bash
cd src-tauri
cargo test
```

Note: on some Windows environments, the test binary may compile but fail to start with a runtime DLL entry-point error. In that case, use `cargo check` and `cargo test --no-run` as the baseline until the local runtime issue is fixed.

## Runtime Data

Runtime data is stored in `.eshell-data/` under the Tauri process working directory. During local development this is usually `src-tauri/.eshell-data/`.

Typical contents:

```text
.eshell-data/
  ssh_configs.json
  scripts.json
  ai_profiles.json
  AGENTS.md
  server_agents/
  ops_agent_conversation_list.json
  ops_agent_conversations/
  ops_agent_context_summaries/
  ops_agent_attachments/
  ops_agent_runs/
  ops_agent_debug.log
```

Persistence notes:

- `ai_profiles.json` is the source of truth for AI profiles, active profile, approval mode, and agent mode.
- `ops_agent_conversations/` keeps the full visible chat history.
- `ops_agent_context_summaries/` stores private model-context summaries and does not replace visible messages.
- `ops_agent_attachments/` stores detached image payloads; conversation JSON stores only `attachmentIds`.
- `AGENTS.md` and `server_agents/` provide user-maintained context injected into model requests.

## Documentation

- [Docs Overview](docs/README.md)
- [Backend Architecture](docs/guides/architecture/backend_architecture.md)
- [Ops Agent Guide](docs/guides/features/ops_agent.md)
- [Ops Agent Layered Architecture](docs/guides/architecture/ops_agent_layered_architecture.md)
- [Project Dev Guide](docs/guides/PROJECT_DEV_GUIDE.md)
- [Project Description](docs/specs/project_description.md)
- [OpenAPI-style RPC Spec](docs/specs/openapi.yaml)
- [Server Status Guide](docs/guides/features/server_status.md)
- [SFTP Transfer Guide](docs/guides/features/sftp_transfer.md)
- [Unreleased Notes](docs/releases/unreleased.md)
- [Release Notes 1.4.0](docs/releases/v1.4.0.md)
