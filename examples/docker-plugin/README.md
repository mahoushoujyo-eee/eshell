# Docker Plugin

A Docker client for eShell: containers, images, volumes, networks, Compose
projects, the daemon's own state and its event stream — all on the **active SSH
session's host**.

## Scope: a remote daemon, not Docker Desktop

The plugin facade gives a plugin `sessions.execute` and nothing else — no local
process spawn, no Docker socket, no HTTP client. So this is a view of the daemon
reachable *from the connected host*, driven by the `docker` CLI over the
session's existing SSH transport. It does not manage local containers.

Three things the CLI does that an exec channel cannot, and what the panel does
instead:

| CLI | Why not | Instead |
| --- | --- | --- |
| `docker exec -it`, `docker attach` | no TTY on the channel | `docker exec` without a TTY: one command, its output, its exit code |
| `docker logs -f`, `docker stats` (streaming) | a stream cannot be interrupted from here | a **follow** toggle that re-reads every 3s, and `stats --no-stream` sampled on a timer |
| `docker events` (open-ended) | same | a bounded window: `--since 30m --until 0s` |
| `docker build` | needs a local build context | — |

## Install

**Settings → Plugins → Install from folder…**, pick this directory. It is copied
to `<storage-root>/extensions/com.example.docker/` and becomes live without a
restart. Or copy it there by hand and restart; for the usual
`npm run tauri -- dev` run that root is `src-tauri/.eshell-data`.

The panel starts hidden — panels are opt-in, so installing a plugin does not
rearrange the dock. Open it from the Docker button in the toolbar's Panels
section. See the
[plugin development guide](../../docs/guides/features/plugin_development.md) for
the storage root, `state.json`, and the trust model.

## What it does

**Containers** — `docker ps -a`, with a state dot, the compose project a
container belongs to, and live CPU/memory from `docker stats --no-stream` when
the **stats** toggle is on. Per row: start / stop / restart / pause / unpause /
kill / rm, logs, inspect, exec, `top`, `diff`, `port`, rename, copy id. Tick
several rows for bulk start / stop / restart / remove. **Run container…** opens
a `docker run` form (ports, env, mounts, network, restart policy, user, workdir,
memory, cpus, `--rm`, `-P`, `--privileged`, command override) with a live preview
of the exact command.

**Images** — `docker images`, with `-a` and dangling filters. Pull (with
`--platform`), run, history, inspect, tag, push, `rmi` / `rmi -f`, and
**Search Hub…** (`docker search`).

**Volumes / Networks** — `docker volume ls` / `docker network ls`, create,
inspect, remove, prune; connect a container to a network. The three predefined
networks cannot be removed, so that action is disabled rather than failing.

**Compose** — projects grouped from the compose labels docker writes on each
container, merged with `docker compose ls --all` so a fully stopped project
still appears. Per project: up / down / down -v / start / stop / restart / pull /
logs / `config`. `up`, `down`, `pull` and `config` need the project's compose
file; when the labels do not report one, those actions are disabled and the
project is tagged **no compose file**.

**Events** — `docker events` over a chosen window.

**System** — `docker info` and `docker version` as tiles and a key/value block,
`docker system df` as a table, `docker system df -v` in a sheet, and every prune
variant (containers, dangling images, all unused images, volumes, networks,
build cache, `system prune`) — each behind a confirmation that names what it
deletes.

**Logs sheet** — `--tail` (100…5000), `--since`, `-t`, a line filter, wrap, copy,
and **follow**.

**Failures a user can act on** — docker missing, the SSH user not in the `docker`
group, the daemon down, `sudo` wanting a password, no `compose` subcommand, an
object already gone, a registry rejecting a push — are explained with the fix,
and the raw stderr stays visible underneath, because the exact path in a socket
permission error is what distinguishes the cases.

**CLI prefix** (⚙) — what actually runs. `sudo -n docker` for a host where the
SSH user is not in the docker group, an absolute path when docker is outside the
non-interactive `PATH`, or `podman`. `-n` matters: a plain `sudo` would block on
a password prompt that this channel can never answer.

**Language** — the panel follows the app's language (English / 简体中文) by
observing `<html lang>`, which the host sets. It cannot import the host's i18n
module, so it ships its own dictionary.

## Command safety

Every command is a fixed verb plus values that are either validated against a
charset that cannot carry shell syntax, or single-quoted:

- container ids `^[0-9a-f]{6,64}$`, names `^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$`
- image ids additionally allow `sha256:`; references
  `^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$` — no space, quote, `;`, `|`, `&`, `$`,
  backtick, glob, newline, or leading `-`
- `-p`, `-e`, `-v`, `--restart`, `--memory`, `--cpus`, `--since`, `--user` and
  signals each have their own pattern; env values and paths are quoted, so
  `/srv/my data:/data:ro` works without becoming three arguments
- an exec command line or a `docker run` command override is **tokenised** and
  re-quoted token by token, the way the CLI parses argv — not pasted in
- the CLI prefix itself is normalised; anything that could carry shell syntax
  falls back to `docker`

A value that fails validation makes the client **reject**, because a reference
the builders refuse means the parse it came from was wrong.

Destructive actions (remove, force remove, prune, compose down, push) go through
a confirmation that shows the exact command.

## Layout

Nothing here is a single large file; each module is small and single-purpose.

```text
index.js            activation and host registration
docker.js           the barrel: one import point for everything below
cli/shell.js        prefix normalisation, quoting, tokenising
cli/validate.js     the charsets every value must match
cli/containers.js   ps / lifecycle / logs / exec / run
cli/images.js       images / pull / push / tag / rmi / search
cli/objects.js      volumes and networks
cli/compose.js      compose ls / up / down / logs / config
cli/system.js       info / version / df / events / prune
parse/lists.js      `--format '{{json .}}'` rows
parse/objects.js    inspect / info / version
failures.js         classification and wording
client.js           the async data layer the controller drives
controller/         prefs, listings, pure derivations, overlays
panel/              rows, toolbar, tabs, sheets, modals
ui/                 presentational primitives over the host React
i18n.js, locales/   en / zh-CN strings
icon.svg            the toolbar icon, served over `plugin://`
```

Output is read as NDJSON (`--format '{{json .}}'`) wherever docker supports it:
docker omits trailing empty fields in `\t` templates, and `Ports`, `Labels`,
`Command` and `Mounts` can all contain the separators a text format would need.
`.State` is missing before Docker 20.10, so it is recovered from the `Status`
text.

## Tests

```sh
npx vitest run src/plugins/__tests__/dockerPluginExample.test.js
```

The suite covers the command builders (including every refusal), the parsers,
the failure classifier, the client's result contract, and the panel's static
render states.
