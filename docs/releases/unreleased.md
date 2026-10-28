# Unreleased Changes

Last updated: 2026-10-28

## Standalone MCP Server And CLI

Two new binaries run eShell's server operations without the desktop app:

- **`eshell-mcp`** — a standard MCP server over stdio, so any MCP client
  (Claude Code, Codex, Cursor, …) can operate the servers eShell manages.
  `--http <port>` switches to the same loopback HTTP transport the in-app
  bridge uses, with the same bearer-token contract.
- **`eshell-cli`** — the same operations from a shell: `profiles`, `exec`,
  `status`, `ls`, `cat`, `write`. `--json` emits machine-readable output, and
  `exec` mirrors the remote command's exit code (255 means eShell itself
  failed, as in OpenSSH).

Both read the same `.eshell-data/` directory, resolve it from `--data-dir`,
`ESHELL_DATA_DIR`, the working directory, or the per-user configuration root,
and open their own SSH connections on demand — a target may be an SSH profile
name or id, so no terminal tab has to exist first.

The MCP protocol logic moved into a transport-agnostic core
(`domain/agent/service/mcp_server.rs`) that the in-app bridge and the
standalone server now share, so both expose the same tools with the same
schemas — nine by default, fewer when a plugin is deactivated. The in-app
bridge keeps its behaviour: it still serves the sessions the user opened, and
the golden `tools/list` contract still holds.

The `initialize` instructions are now per-server. The in-app bridge still
points the agent at `list_shell_sessions`; the standalone server points it at
`list_ssh_profiles` and lets a profile name stand in for a session id, because
it has no terminal tabs to look for.

See [Standalone MCP Server And CLI](docs/guides/features/standalone_mcp_cli.md).

## Xray Proxy Plugin Example

`examples/xray-plugin/` is a worked example of an external eShell plugin: a
panel for the xray installation on the machine you are connected to — its
groups, its subscriptions, and the node each group uses. Install it from
**Settings → Plugins → Install from folder…**.

## How To Use This File

Record notable user-facing changes on the current branch here as they land, then
move them into `v<next>.md` when cutting a release. The release workflow reads
`docs/releases/<tag>.md` for the GitHub release body, so a tag without that file
fails the build.
