# eShell

<p align="center">
  <img src="docs/assets/Shell.png" alt="eShell Logo" width="180" />
</p>

**eShell v1.6.0** is a desktop operations workbench built with **Tauri 2, React 19, and Rust**.

It combines SSH sessions, PTY terminals, SFTP file operations, server status monitoring, reusable scripts, and an ACP coding agent panel in one local-first application.

[中文说明](README.zh-CN.md)

## What It Does

- Manage multiple SSH profiles and switch active sessions quickly.
- Use an interactive `xterm.js` PTY terminal with resize sync, custom wallpaper, and Ctrl+Shift+C/V clipboard shortcuts.
- Recover a dead terminal in place: the reconnect button rebuilds the PTY on the same session, keeping the tab, its working directory and its status cache.
- Browse, preview, edit, upload, download, and delete files through SFTP.
- Monitor remote server CPU, memory, network traffic, processes, disks, and NVIDIA GPUs.
- Save reusable scripts and run them against the active session.
- Drive external coding agents (Codex, Claude Code, Gemini CLI, …) over the Agent Client Protocol, with per-project sessions and permission prompts.
- Configure multiple AI provider profiles for OpenAI Chat Completions, OpenAI Responses, and Anthropic Messages compatible APIs.
- Install, enable, and remove extensions from **Settings → Plugins**; external plugins are local ESM directories and take effect without a restart.
- Use English or Simplified Chinese UI with persisted locale preference.

## ACP Agent Panel

The main AI entry point is the ACP panel, which drives an external coding agent as a child process over JSON-RPC on stdio.

- Agents are declared in `.eshell-data/acp_agents.json`; the panel lists them and starts one on demand.
- Sessions are grouped by **project** (a local folder recorded in `.eshell-data/projects.json`), so switching projects does not restart the agent process.
- Transcripts are persisted app-side under `.eshell-data/acp_sessions/` and can be resumed.
- Permission requests from the agent surface as approval cards; `session/cancel` also cancels any pending request.
- The panel exposes the MCP bridge, so an agent can call eShell's own tools.

All agent work is delegated to external ACP agents; the former self-hosted Ops Agent runtime was removed from the backend.

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
- russh / russh-sftp (async SSH, one connection per tab)
- reqwest
- serde / serde_json

## Extensions

SFTP and server monitoring remain enabled-by-default built-in extensions. Their
existing UI and command contracts are preserved, and they consume the same API-v1
facade available to trusted external browser-ESM plugins.

Install a plugin from **Settings → Plugins → Install from folder…**: pick a plugin
directory and it is copied to `<storage-root>/extensions/<manifest id>/` and becomes
live immediately. The same tab enables/disables each extension and removes external
ones. Built-in extensions can only be toggled — their code ships with the app.

Three ready-to-load examples ship in the repo:

- [`examples/hello-plugin/`](examples/hello-plugin/) — minimal: a manifest, a
  controller, a panel, a relative import.
- [`examples/docker-plugin/`](examples/docker-plugin/) — a Docker client for the
  active session's host: containers, images, volumes, networks, Compose, events
  and `docker system df`, with `docker run` / `exec` / logs.
- [`examples/k8s-plugin/`](examples/k8s-plugin/) — a kubectl client: any resource
  type in any namespace or context, logs with a container picker, scale, rollout,
  drain, `kubectl top`, and `apply -f -`.

You can also install by hand: close eShell, copy the whole directory to
`<storage-root>/extensions/<id>/`, and restart. In a typical desktop dev run, that
root is `src-tauri/.eshell-data`.

Installing, removing, and toggling take effect without a restart. **Editing plugin
code does not** — source changes need a process restart; there is no file hot reload.

**Only install code you trust.** Plugins share the application's JS context and
Tauri capabilities; the facade is not a sandbox or plugin permission system.
There is no marketplace, automatic plugin updater, or Node host. Native
implementation updates still ship with eShell.

See [Plugin Development](docs/guides/features/plugin_development.md) and
[Extension Architecture](docs/guides/architecture/builtin_extensions.md).

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
  plugins/         # built-in SFTP/status controllers and contributions
  lib/
    tauri-api.js
    ops-agent-stream.js
    ops-agent-message-rendering.js
    ops-agent-shell-context.js
    sftp-transfer.js
    i18n.js

src-tauri/src/
  domain/          # per-domain model / service / command layers
    ssh/           # SSH transport, PTY workers, session commands
    sftp/          # SFTP operations and transfer cancellation
    config/        # persisted SSH configs / known hosts / reload bridge
    scripts/       # saved script definitions and execution
    ai/            # AI provider profiles, import, agent context
    monitor/       # server metric probes and status cache
    extensions/    # builtin + external plugin runtime, plugin:// protocol
    ops_agent/     # ACP client: external agent spawn, sessions, history
  common/          # error types, time, debug logging
  state.rs

examples/          # ready-to-load external plugins (hello, docker, k8s)
skills/            # agent-facing references seeded into .eshell-data/agent/skills/

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

- Node.js 22.12+ (Node 24 also works)
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
  known_hosts.json
  scripts.json
  ai_profiles.json
  acp_agents.json
  acp_sessions/
  projects.json
  agent/
    AGENTS.md
    <serverId>.md
    skills/
  server_ops_debug.log
```

Persistence notes:

- `ai_profiles.json` is the source of truth for AI profiles, active profile, approval mode, and agent mode.
- `acp_agents.json` declares the ACP agents the panel can spawn; `acp_sessions/` holds one transcript per session.
- `projects.json` maps ACP projects to local folders.
- `agent/AGENTS.md` is the global agent context file, `agent/<serverId>.md` the per-server one, and `agent/skills/` holds the bundled `eshell-config` and `eshell-plugin-dev` skills.
- `server_ops_debug.log` records server-operation events (`pty.worker.started`, `status.probe.failed`, …) and is the first place to look when a session misbehaves.

## Documentation

- [Docs Overview](docs/README.md)
- [Backend Architecture](docs/guides/architecture/backend_architecture.md)
- [SSH Transport](docs/guides/architecture/ssh_transport.md)
- [Webshell Session](docs/guides/features/webshell_session.md)
- [ACP Agent Guide](docs/guides/features/acp_agent.md)
- [ACP Panel Frontend](docs/guides/features/acp_panel_frontend.md)
- [Project Dev Guide](docs/guides/PROJECT_DEV_GUIDE.md)
- [Project Description](docs/specs/project_description.md)
- [OpenAPI-style RPC Spec](docs/specs/openapi.yaml)
- [Server Status Guide](docs/guides/features/server_status.md)
- [SFTP Transfer Guide](docs/guides/features/sftp_transfer.md)
- [Plugin Development](docs/guides/features/plugin_development.md)
- [Unreleased Notes](docs/releases/unreleased.md)
- [Release Notes 1.6.0](docs/releases/v1.6.0.md)
