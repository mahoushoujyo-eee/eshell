# Unreleased Changes

Last updated: 2026-11-07

## No More Console Windows When The Panel Opens

Opening the ACP panel flashed two black console windows.

The panel probes the Node.js toolchain on open (`node --version` and
`npx --version`), and eShell is a GUI-subsystem process: on Windows a console
child of a console-less parent gets a console of its own, visible. The probes now
pass `CREATE_NO_WINDOW`, like the agent spawn already did, and the result is
cached for the rest of the process — the probe only runs when the panel is
opened, so the cache removes the repeated spawns entirely. The panel's "check
again" button still forces a fresh probe, which is the whole reason it exists.

## The CLI Finds The Desktop App's Configuration

`eshell-cli` and `eshell-mcp` ended up in a different data directory than the
app, so every command needed `--data-dir` and a first run could create an empty
second configuration where the user's servers appeared to be missing.

The installer lays both out predictably — `<install>\eshell.exe`,
`<install>\cli\eshell-cli.exe`, `<install>\.eshell-data` — so the tools now
derive the app's configuration from their own executable path: look one and two
levels up for `.eshell-data`, and accept it only when it actually contains
configuration files (`ssh_configs.json`, `known_hosts.json`, …), so an empty
directory of the same name is not mistaken for the user's data.

```
$ eshell-cli config
Data directory: C:\Users\<you>\AppData\Local\eshell\.eshell-data
SSH profiles:   9
```

`--data-dir` and `ESHELL_DATA_DIR` still win when given, and a tool copied away
from the install layout falls back to the per-user directory as before.

## Files And Quoted Text In The Prompt

Two ways to point the agent at something without retyping it:

- **Attach file paths.** The paperclip in the composer opens the file dialog, and
  dropping files onto the panel works too — both insert the *paths*, one per
  line as inline code. The agent runs on the same machine and reads the file
  itself, which beats shipping a stale copy through the transcript.
- **Quote the transcript.** Select any part of the conversation and a "Quote in
  reply" pill appears next to the selection; clicking it appends the selection to
  the composer as a blockquote, ready for the question.

Both append to the end of what is already typed rather than inserting at the
caret, so a half-written sentence is never split.

## How To Use This File

Record notable user-facing changes on the current branch here as they land, then
move them into `v<next>.md` when cutting a release. The release workflow reads
`docs/releases/<tag>.md` for the GitHub release body, so a tag without that file
fails the build.
