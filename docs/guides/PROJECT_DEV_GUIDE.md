# Project Dev Guide

Last updated: 2026-04-28

## 1. Engineering Priorities

1. Keep session behavior correct and recoverable.
2. Keep operational actions observable via logs/events.
3. Keep modules small and responsibilities clear.
4. Keep approval and cancellation paths explicit.

## 2. Source of Truth

Runtime API surface is defined by:
- `src-tauri/src/lib.rs` command registration
- `src/lib/tauri-api.js` frontend invoke wrappers

When adding or changing commands:
1. Update backend command + model
2. Register command in `lib.rs`
3. Update `tauri-api.js`
4. Update docs (`docs/specs/openapi.yaml` + feature docs)

For Ops Agent changes, also update:
- `docs/guides/features/ops_agent.md`
- `docs/guides/architecture/ops_agent_layered_architecture.md` when package boundaries, persistence layout, or request flow changes

When changing user-visible frontend copy:
- update `src/lib/i18n.js`
- verify both `en-US` and `zh-CN`
- keep new notices / busy labels / modal copy on the shared translator instead of hard-coded strings

## 3. Workbench Frontend Pattern

`useWorkbench` is the composition root, with logic split into:
- `workbench/operations.js`
- `workbench/effects.js`
- `workbench/session.js`
- `workbench/errors.js`

Rule:
- New behavior should be added to the correct split module, not merged back into a large monolith.

## 3.1 Built-in Extension Boundaries

- SFTP and monitoring implementations belong to `src/plugins/` and `src-tauri/src/plugins/`; do not add their feature logic back to the core workbench or SSH transport.
- `extensions/builtin.json` is shared manifest metadata for both runtimes.
- Preserve existing panel IDs, markup, styles, settings keys, command contracts, and default polling/transfer behavior during migration.
- Lifecycle APIs are additive; persistent deactivation must not close user SSH sessions, silently cancel transfers, bypass caller/provider busy leases, or publish a state change when persistence fails.
- Trusted external ESM loads before the initial React render through the native plugin protocol. Each external controller needs its own keyed React component; never run a dynamic hook loop in `useWorkbench`.
- The plugin API is a contract, not a sandbox. Validate discovery/resource paths independently and retain the current monitor's serialized polling, batched probes and 20-second budget.
- Install and uninstall go through the same discovery validation as a startup scan, and must validate before copying so a rejected install leaves nothing behind. The catalog is re-scanned at runtime; a re-scan must not change an existing extension's explicit activation flag.
- See [Plugin Development](features/plugin_development.md) for the API-v1 contract and the two ready-to-load examples.
- See [Built-in Extensions](architecture/builtin_extensions.md) for ownership, lifecycle, and verification requirements.

## 3.2 Bundled Agent Skills

`skills/` holds agent-facing references that ship with the app. Each is seeded
into `.eshell-data/agent/skills/<name>/` on first launch (written only when
missing, so a user or agent edit survives) and returned by the MCP
`read_agent_context` tool.

- `skills/eshell-config/` — editing `.eshell-data/*.json` (SSH/ACP schemas, wire formats, server-operation norms, restart rules).
- `skills/eshell-plugin-dev/` — writing an external plugin (manifest, API v1 facade, lifecycle, install flow, trust model).

Adding a skill means three edits, not one: the directory under `skills/`, a
`seed_*_skill` call in `src-tauri/src/storage/mod.rs`, and an entry in
`BUNDLED_SKILLS` in `src-tauri/src/mcp_bridge/mod.rs` so the agent can read it.
`storage::tests::bundled_skills_are_seeded_on_first_run` covers the seed.

## 4. SFTP Transfer Conventions

Events:
- backend emits `sftp-transfer`
- frontend normalizes in `src/lib/sftp-transfer.js`

Stage values:
- `queued`
- `started`
- `progress`
- `completed`
- `failed`
- `cancelled`

Current command set:
- `sftp_list_dir`
- `sftp_read_file`
- `sftp_write_file`
- `sftp_create_file`
- `sftp_create_directory`
- `sftp_delete_entry`
- `sftp_upload_file_with_progress`
- `sftp_download_file_to_local`
- `sftp_default_download_dir`
- `sftp_cancel_transfer`

Shell connection cancellation:
- `open_shell_session` accepts optional `requestId`
- `cancel_open_shell_session` marks the request as cancelled
- backend cancellation is checked during the TCP connection phase; SSH handshake/auth remain blocking for compatibility

## 5. Safety and UX Rules

- Risky shell writes must remain approval-gated in Ops Agent flow.
- Transfer cancel should be user-visible and reflected in UI state.
- Cancel should not be reported as a generic failure toast.
- Avoid UI layout regressions: use collapsible/overlay controls for dense operational data.
- Prefer switching or progressive disclosure when status data becomes too dense to scan in one view.
- Preserve unit clarity in UI labels when backend semantics change (`GB` vs `MB`, percent vs absolute values).

## 6. Logging and Observability

- Ops Agent debug logs should remain rich enough to reconstruct request assembly, provider exchange, stream flow, and compaction decisions.
- If attachment behavior changes, logs should still let us trace save / load / delete paths by conversation and run context.
- New logs must include shared run / conversation context when available.
- Log previews should be truncated rather than omitted entirely so failures remain diagnosable without dumping full payloads.

## 7. Testing Baseline

Before merge, run:

```bash
npm test
npm run build
cd src-tauri
cargo check
```

If `cargo test` cannot execute in the local environment (e.g., host runtime DLL issue),
record that limitation explicitly in PR notes and keep `cargo check` green.

## 8. Documentation Checklist

For any feature-level change:
- update `README.md` user-facing behavior
- update `docs/specs/openapi.yaml` command contract
- update feature docs under `docs/` as needed
- update `docs/guides/features/server_status.md` for status-panel semantics or units
- if the change affects Ops Agent flows, update `docs/guides/features/ops_agent.md`
- if the change affects Ops Agent layering, persistence files, or multimodal flow, update `docs/guides/architecture/ops_agent_layered_architecture.md`
- update `docs/releases/unreleased.md` for notable user-facing changes on the current branch
