# Docker Plugin

A Docker panel for eShell: lists containers and images on the **active SSH
session's host** and runs start / stop / restart / remove / logs on them.

## Scope: remote host, not Docker Desktop

The plugin facade gives a plugin `sessions.execute` and nothing else — no local
process spawn, no Docker socket, no `docker exec`. So this is a view of the
daemon reachable *from the connected host*, driven by the `docker` CLI over the
session's existing SSH transport. It is not a Docker Desktop replacement and it
does not manage local containers.

## Install

Close eShell, copy this whole directory to
`<storage-root>/extensions/com.example.docker/`, and start eShell again. For the
usual `npm run tauri -- dev` run that is:

```text
src-tauri/.eshell-data/extensions/com.example.docker/
  manifest.json
  index.js
  docker.js
```

The panel starts hidden — panels are opt-in, so installing a plugin does not
rearrange the dock. Open it from the Docker button in the toolbar's Panels
section. See the
[plugin development guide](../../docs/guides/features/plugin_development.md)
for the storage root, `state.json`, and the trust model.

## What it does

**Containers** tab — `docker ps -a`, with a state dot, image, status, and
per-container actions. The buttons follow the container's state, because docker
itself refuses the impossible ones:

| State | Offered |
| --- | --- |
| running | Stop, Pause, Restart, Logs, Inspect |
| paused | Unpause, Restart, Logs, Inspect |
| exited | Start, Restart, Logs, Inspect, Remove |

`docker rm` refuses both a running and a paused container, so Remove only
appears where it can succeed.

**Images** tab — `docker images`, plus a pull field (`docker pull <ref>`) and
`docker image prune -f` for dangling images. Each row has Remove (`docker rmi`).

**Disk** tab — `docker system df`, fetched only when the tab is open.

**Logs** overlay — `docker logs --tail <n>`, with a tail selector (100 / 200 /
1000 / 5000), a Reload button, and a **follow** toggle that re-reads every 3s.

**Inspect** overlay — `docker inspect`, rendered as a summary (image, status,
health, restart policy, command, ports, mounts, networks) with the raw JSON
collapsed underneath.

Re-lists when the active session changes; a manual Refresh button.

Failures a user can act on — docker not installed, the SSH user not in the
`docker` group, the daemon not running — are explained with the fix, and the
raw stderr stays visible underneath, because the exact path in a socket
permission error is what distinguishes the cases.

## What it deliberately does not do

- **No `docker exec` and no shell interpolation.** Every command is a fixed
  verb plus an id or reference that is validated before it reaches the command
  line: container ids must match `^[0-9a-f]{6,64}$`, image ids additionally
  allow a `sha256:` prefix, and a pull reference must match
  `^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$` — which cannot carry a space, quote, `;`,
  `|`, `&`, `$`, backtick, glob, newline, or a leading `-`. A rejected value
  means the parse went wrong, not that the plugin should guess.
- **No auto-refresh of the listings.** Each listing is one command per tab on
  demand; a timer would compete with whatever else is using the session. The
  log *follow* toggle is the one exception, and it is off by default and
  cleared when the overlay closes.
- **No compose, volumes, or networks.** Those need either a destructive
  confirmation flow or a much larger surface; this stays a readable example.
- **No confirmation dialog on Remove / Prune.** They run immediately and report
  the outcome. Prune only removes dangling images (`docker image prune -f`, no
  `-a`), which is the recoverable case.

## Layout

- `docker.js` — commands, output parsers, failure classification, and
  `createDockerClient`. No React and no facade, so the whole command/parse path
  is unit-testable on its own.
- `index.js` — the controller (view state) and the panel render.
- `icon.svg` — the toolbar icon, referenced as
  `new URL("./icon.svg", import.meta.url).href`. The host serves it over the
  same `plugin://` origin as the module, so the icon ships with the plugin and
  needs no host-side registration. It strokes in `currentColor` so it follows
  the rail button's active/idle colour.
- `../../src/plugins/__tests__/dockerPluginExample.test.js` — the suite.

## Tests

```sh
npx vitest run src/plugins/__tests__/dockerPluginExample.test.js
```
