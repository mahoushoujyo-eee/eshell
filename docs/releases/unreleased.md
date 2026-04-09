# Unreleased Changes

Last updated: 2026-04-09

## Highlights

- Added app-level English / Simplified Chinese switching with persisted locale selection.
- Localized major workbench surfaces including toolbar actions, terminal, SFTP, status panel, AI panel, config dialogs, and notices.
- Refined the server status panel so `Processes` and `Disks` switch within the same area instead of stacking in one crowded block.
- Changed top-process memory from percentage to RSS-based `MB`, while the memory summary remains `used / total` in `GB`.
- Narrowed the SFTP tree pane so the remote entry list has more practical space.
- Expanded Ops Agent debug logging to capture request setup, provider request / response summaries, stream events, and compaction decisions.

## Validation

- `npm run build`
- `npm test`

## Follow-up Notes

- `cargo check` was already kept green during the Rust-side logging and status-field changes that landed alongside this branch.
- `docs/refer_proj/` contains external reference material used for product study and is intentionally not included in the main feature summary here.
