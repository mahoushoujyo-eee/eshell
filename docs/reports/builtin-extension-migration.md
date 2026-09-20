# SFTP / Server Monitoring Migration Validation

Date: 2026-09-18  
Pre-migration reference: `e4e215e` (`v1.5.5`)

## Delivered scope

- Enabled-by-default native/frontend modules for `eshell.sftp` and
  `eshell.server-monitor`, using `extensions/builtin.json`.
- Feature-owned operations, state, probes, transfer bookkeeping, and panel/toolbar
  contributions, with legacy workbench and Tauri compatibility adapters.
- Run-local activation APIs and events, atomic busy leases/lifecycle changes,
  and MCP tool discovery/dispatch through the owning extensions.
- No theme changes, new management UI, third-party installer, Node host, or
  independent native-plugin updates.

## Automated checks

| Check | Result |
| --- | --- |
| Pre-migration frontend baseline | 36 tests passed; production build passed |
| Final `npm test` | 106 tests passed, 16 test files |
| Final `npm run build` | Passed |
| Final `cargo check --manifest-path src-tauri/Cargo.toml` | Passed; 5 existing library warnings |
| Final `cargo test --manifest-path src-tauri/Cargo.toml --lib` | 233 passed, 0 failed, 1 ignored |
| Existing Tauri command names | All 80 retained; only 2 lifecycle commands added |
| Existing frontend invoke facade | All 62 old methods AST-identical |
| Migrated panel/component helpers | All 16 implementation bodies AST-identical, excluding imports/comments/formatting |
| Existing stylesheets | No changes; no new stylesheets |
| Default MCP `tools/list` | Matches the frozen pre-migration golden |
| RPC documentation | YAML parsed successfully; 48 documented paths |
| `git diff --check` | Passed |

The ignored Rust test is the pre-existing opt-in live AI smoke test
(`live_smoke_uses_first_usable_profile`), not a failed migration test. Rust tests
include local loopback SSH/SFTP integration and concurrent lifecycle checks.
The existing large-chunk Vite warning remains; test builds also emit dead-code
warnings for code not exercised by that build target.

Regression tests cover the compatibility return keys and settings callback,
actual workbench/controller composition, polling without feedback loops,
700 ms owning-session autosave across unrelated renders, stable transfer
subscriptions, KeepAlive identity, asynchronous listener registration, stale
initialization/command replies, rejected toggles, and native lease/deactivation
races.

## Browser validation

The original production `dist` was copied before any implementation edits.
Both that build and the migrated build were driven in headless Microsoft Edge
at 1680 x 1050 using the same fictional Tauri responses and interactions.
No user SSH host or saved credentials were used.

For each build:

- 25 interaction scenarios completed.
- 30 DOM assertions passed.
- 26 screenshots captured.
- Zero console errors, warnings, or page exceptions.

Scenarios include SFTP/status/draft panel combinations, panel hide/show state,
session switching, NIC selection, GPU detail, browsing directories, opening the
file editor, binary-file guard, upload/download progress, rename/create/delete
flows, PTY disconnect/reconnect, SSH configuration, Settings, AI dock, sidebar
collapse, and polling interval selection.

The first comparison had 17/26 byte-identical PNGs. A second comparison waited
350 ms before screenshots to avoid sampling hover/disabled transitions. Across
the two runs, 24/26 scenes had an exact pixel match. The other two differed by
only 47 and 26 pixels in the original comparison (maximum channel deltas 8 and 5,
within the existing sidebar rendering), not by layout or content. Timed status
samples, toast expiry, and CSS transition frames can differ across captures;
this is not a claim that every screenshot from arbitrary wall-clock timing is
byte-identical. Representative before/after images were also visually inspected.

In the first full run, all 61 SFTP/status command invocations had identical
command/argument multisets between builds after excluding generated request and
transfer IDs. Session and path attribution therefore matched. PTY resize counts
and listener-registration counts are not used as exact timing-independent
contracts.

Local evidence for this session is under the temporary directory
`eshell-ui-baseline-20260918-181532` in the user's system temp folder:

- `dist/`: frozen pre-migration build.
- `baseline-run/`, `postmigration-run/`: first reports, screenshots, invocation logs.
- `baseline-settled-run/`, `postmigration-settled-run/`: transition-settled captures.
- `run-baseline.mjs`, `mock-tauri.js`, `server.js`, `cdp-client.js`: local driver.

Temporary evidence is not a repository dependency and may be removed by system
cleanup. Frozen UI snapshots and behavioral tests are kept as source files
in the working tree under `src/components/__tests__/` and `src/plugins/__tests__/`.

## Remaining validation boundary

Browser testing uses mocked Tauri responses; it is not native desktop/real-host
end-to-end validation. Real SSH authentication, interactive keyboard prompts,
large-file transfer, interrupted networks, and native file pickers still need
release smoke testing against an explicitly authorized test host. The migration
does not imply arbitrary third-party plugin execution is available or sandboxed.
