# Docs Overview

`docs/` is organized by document purpose so prompts, specs, guides, and working notes stay separate.

## Structure

- `assets/`: documentation images and static assets
- `debug/`: temporary debug output captured during investigation
- `guides/`: development and feature behavior guides
- `guides/architecture/`: stable architecture maps and package-boundary references
- `guides/features/`: feature-specific guides such as Ops Agent, server status, and SFTP transfer
- `prompts/`: prompts used to generate or evolve the project
- `reports/`: remediation checklists, TODOs, and other progress records
- `releases/`: release notes
- `scratch/`: temporary drafts, samples, or ad hoc notes
- `specs/`: project-level specifications and API contracts
- `refer_proj/`: local reference projects and reverse-engineering material

## Placement Rules

- New project-generation or refactor prompts go in `prompts/`.
- Stable behavior or developer documentation goes in `guides/`.
- API contracts and scope definitions go in `specs/`.
- Temporary notes, checklists, and one-off records go in `reports/` or `scratch/`.
- Large external references stay under `refer_proj/`.
- Temporary debug dumps, scratch captures, and one-off TODO notes should be deleted after their conclusions are folded into stable docs.

## Document Index

- [Backend Architecture](guides/architecture/backend_architecture.md) — Complete implementation guide for the Rust backend (state, SSH/PTY/SFTP, Ops Agent, ReAct loop, approvals, providers)
- [Project Description](specs/project_description.md) — Product scope, runtime state, and feature models
- [OpenAPI-style RPC Spec](specs/openapi.yaml) — Tauri invoke command contracts
- [Project Dev Guide](guides/PROJECT_DEV_GUIDE.md) — Engineering workflow, testing baseline, and documentation checklist
- [SFTP Transfer Guide](guides/features/sftp_transfer.md) — SFTP browser operations, transfers, cancellation, and context-menu behavior
- [Server Status Guide](guides/features/server_status.md) — Status panel data semantics and UI behavior
- [Ops Agent Guide](guides/features/ops_agent.md) — Ops Agent request flow, approvals, streaming, attachments, and cancellation
- [Unreleased Notes](releases/unreleased.md) — Current branch user-facing changes
