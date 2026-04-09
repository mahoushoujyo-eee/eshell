# Project Dev Guide

Last updated: 2026-04-09

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
4. Update docs (`openapi.yaml` + feature docs)

For Ops Agent changes, also update:
- `docs/ops_agent.md`

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
- `workbench/aiProfiles.js`

Rule:
- New behavior should be added to the correct split module, not merged back into a large monolith.

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
- `sftp_upload_file_with_progress`
- `sftp_download_file_to_local`
- `sftp_default_download_dir`
- `sftp_cancel_transfer`

## 5. Safety and UX Rules

- Risky shell writes must remain approval-gated in Ops Agent flow.
- Transfer cancel should be user-visible and reflected in UI state.
- Cancel should not be reported as a generic failure toast.
- Avoid UI layout regressions: use collapsible/overlay controls for dense operational data.
- Prefer switching or progressive disclosure when status data becomes too dense to scan in one view.
- Preserve unit clarity in UI labels when backend semantics change (`GB` vs `MB`, percent vs absolute values).

## 6. Logging and Observability

- Ops Agent debug logs should remain rich enough to reconstruct request assembly, provider exchange, stream flow, and compaction decisions.
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
- update `docs/openapi.yaml` command contract
- update feature docs under `docs/` as needed
- update `docs/server_status.md` for status-panel semantics or units
- if the change affects Ops Agent flows, update `docs/ops_agent.md`
- update `docs/releases/unreleased.md` for notable user-facing changes on the current branch
