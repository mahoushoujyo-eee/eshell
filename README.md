# eShell

eShell is a Tauri2 + React + Tailwind CSS desktop app inspired by FinalShell.

## Features

- SSH connection profile management (CRUD + JSON persistence)
- Multi-session shell tabs (independent state per tab)
- SFTP directory browsing, file upload/download, and live file editing
- Real-time server status (CPU/memory/network/process/disk, refresh every 5s)
- Script management and execution in selected shell session
- OpenAI-compatible AI assistant (custom base URL / key / model)
- Session-bound status cache for fast tab switching

## Stack

- Tauri 2 + Rust backend
- React (JavaScript) frontend
- Tailwind CSS (via Vite plugin)
- Vite build tool

## API Docs

- OpenAPI spec: `docs/openapi.yaml`

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/)
- [Tauri VS Code extension](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode)
- [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
