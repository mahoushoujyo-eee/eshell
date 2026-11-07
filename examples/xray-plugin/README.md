# Xray Proxy Plugin

A proxy panel for eShell: the xray installation on the machine you are
connected to — its **groups**, its **subscriptions** and the **node** each
group uses.

## Scope: xray on the remote host

The plugin facade gives a plugin `sessions.execute` and nothing else — no
local process spawn and no HTTP client. So this drives the `xray` binary *on
the connected host*: the box that terminates the traffic. Your laptop's
xray, your laptop's proxy and your laptop's network are not involved.

The subscription is downloaded **by the host**, for the same reason: a
provider's link often only resolves from the network the proxies live on, and
the panel has no way to fetch it itself.

## Install

**Settings → Plugins → Install from folder…**, pick this directory. It is
copied to `<storage-root>/extensions/com.example.xray/` and becomes live
without a restart. Or copy it there by hand and restart; for the usual
`npm run tauri -- dev` run that root is `src-tauri/.eshell-data`.

The panel starts hidden — panels are opt-in. Open it from the Xray Proxy
button in the toolbar's Panels section. See the
[plugin development guide](../../docs/guides/features/plugin_development.md)
for the storage root, `state.json`, and the trust model.

## The model

The panel works in Xray's own vocabulary, because there is no other one that
survives a restart:

| Panel | Xray | What it is |
| --- | --- | --- |
| **group** | `routing.balancers[]` | a tag, the tag prefixes it selects from, and the strategy it picks with |
| **node** | `outbounds[]` | one proxy server, tagged so a balancer's `selector` finds it |
| **subscription** | — | a URL the host downloads; its nodes are written into the config under a prefix |
| **rule** | `routing.rules[]` | what sends traffic to a balancer — **read, never written** |

A subscription owns every outbound whose tag carries its prefix, so an update
replaces that set as a whole: a node the provider dropped disappears, and a
node it added appears.

## What it does

**Detection.** One round trip asks the host for the binary, the config file,
the service unit, whether this user may write the config, and whether `sudo -n`
works. The config path comes from the systemd unit's `ExecStart` when there is
one — which is where the real path is — and from the usual locations
otherwise. Every answer can be overridden in the settings.

**Groups.** List the balancers with their strategy, their selector and how many
nodes they select. Add one, edit one, delete one. A group no routing rule
uses is marked *unused*, because a balancer nothing routes to is a balancer
that does nothing.

**Subscriptions.** Add a link, update it, delete it. The URL is masked in the
list — it carries the account token — and stored locally, like the SSH
configs the app already keeps. The row shows how many nodes the config holds
against how many the provider last served, so a subscription that was never
applied is visible.

**Nodes.** The nodes of the selected group, with their protocol, endpoint,
transport and — when the config has an observatory — the delay xray measured
for them.

**Selecting a node.** A balancer picks between the outbounds its selector
matches. Selecting a node therefore narrows that selector to that one
outbound, which is written to the config and **survives a restart** — unlike a
runtime override that only lives in the running process. *Automatic* hands the
group back to its strategy.

**Probing.** *Probe the live path* measures a request through the local SOCKS
inbound, so what is measured is the path the server is actually using.

## The write path

Every change to the config goes through the same five steps, and the order is
the point:

1. `cp -p` the config aside, keeping its mode and its owner;
2. write the new JSON into that copy and `mv` it over the original — atomic
   within one directory, so a half-written config is never left behind;
3. `xray run -test -config` — xray parses the file and exits without binding
   a port;
4. **restore the backup** when that parse fails, and stop there: the service
   is not restarted onto a config xray could not read;
5. restart the service and report whether it came back.

Step 3 is what makes this safe to expose in a UI. The panel can write a
configuration it built; it never lets xray start with one it could not parse.

## What the write path needs from the host

The panel never writes a config it could not back up, and it replaces the file
by a rename so xray never reads a half-written one. Both steps happen **in the
config's own directory**:

```text
/etc/xray/config.json          the file
/etc/xray/config.json.eshell-backup   the backup, next to it
/etc/xray/config.json.eshell-tmp      the new file, renamed over it
```

So the SSH user needs write access to **the file and its directory**. The
usual xray install leaves both root-owned, and the panel reports exactly what
is missing in the Overview tab:

| what the host says | what it means | what to do |
| --- | --- | --- |
| `Writable: no`, `sudo -n` unavailable | nothing may be changed | `chown -R <ssh-user> /etc/xray` |
| `Writable: no`, `sudo -n` available | the panel writes through sudo | set the privilege prefix to `sudo -n` |
| `Writable: yes`, `Directory writable: no` | the file may be written, but the backup cannot be put next to it | `chown <ssh-user> /etc/xray` |

`sudo -n` is the only privilege prefix the panel offers, and it is the only
one that works on a non-interactive channel: a cached sudo credential belongs
to the terminal that typed the password, so `sudo -v` in a terminal tab does
**not** carry over to the panel's command channel. NOPASSWD in sudoers, or
ownership of the config, is what it takes.

## Command safety

Every value that reaches a command line is either validated against a charset
that cannot carry shell syntax, or single-quoted:

- tags and prefixes `^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$`
- the config path `/^[A-Za-z0-9._/@:+-]{1,240}$` — narrow on purpose, because
  the write command runs the path inside a double-quoted `sh -c` script
- subscription URLs: `http(s)` only, no whitespace, no quotes
- the privilege prefix: the empty string, or `sudo -n` with an optional
  `-u <user>` — a plain `sudo` would wait for a password this channel cannot
  type

The config body travels on stdin through a quoted heredoc, so the shell
performs no expansion on it and the JSON is never interpreted as shell
syntax. The delimiter is checked against the body first.

## What it does not do

- **No Clash YAML.** A Clash subscription is detected and refused with an
  explanation rather than half-imported. Ask the provider for the v2ray (link)
  subscription, or convert it on the host. The reader for it would be
  `parse/clash.js`.
- **No scheduled updates.** There is no timer that survives the panel being
  closed; *Update* is a button.
- **No runtime override.** The Xray management API could switch a balancer
  without a restart, but the CLI that does it has moved between releases; the
  panel prefers the route that works on every version.
- **No per-node latency of its own.** The delay column is read from the xray
  log, so it needs an observatory in the config. Without one, only the live
  path can be probed.
- **No routing rules.** The panel reads them so it can tell you that a group
  is unused. It does not write them.

## Layout

Nothing here is a single large file; each module is small and single-purpose.

```text
index.js            activation and host registration
xray.js             the barrel: one import point for everything below
cli/shell.js        quoting, the heredoc, the privilege prefix
cli/validate.js     the charsets every value must match
cli/detect.js       the one-shot detection script and its reader
cli/config.js       read, back up, write, validate, restore, restart
cli/subscription.js the download and the latency probe
parse/config.js     the config as a model: groups, nodes, outbounds
parse/uri.js        vless / vmess / trojan / ss share links → outbounds
parse/subscription.js the subscription formats the panel reads
parse/observatory.js the delay measurements out of the xray log
failures.js         classification and wording
client.js           the async data layer, including the safe write path
controller/         view state (prefs, derivations, overlays)
panel/              header, overview, groups, subscriptions, nodes, modals
ui/                 presentational primitives over the host React
i18n.js, locales/   en / zh-CN strings
icon.svg            the toolbar icon, served over `plugin://`
```

### Why the write path is in the client

The plugin code runs in the host's context, so the unit tests can only cover
the parts that do not depend on the DOM and the facade. The command
builders, the config model, the share-link readers and the failure classifier
are all plain functions over plain data — that is where the rules live, and
that is what the suite tests. The write path is tested against a fake
`execute`, which is enough to prove the *order*: the backup comes first, the
restart comes last, and a failed validation restores the file and stops.

## Tests

```sh
npx vitest run src/plugins/__tests__/xrayPluginExample.test.js
```

The suite covers the command builders and their refusals, the detection
readers, the config model, the share-link readers, the subscription formats,
the log reader, the failure classifier, the write path's ordering, and the
panel's static render states.

As with every plugin here: a passing suite and a successful frontend build
are **not** a substitute for running it in the desktop app. The custom
protocol and the WebView2 load have to be verified there.
