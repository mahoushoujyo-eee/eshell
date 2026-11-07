// Detecting what is on the host.
//
// The panel has to find four things before it can do anything: the xray
// binary, the config file, the service unit, and whether this user may write
// the config. Guessing any of them from the outside gets it wrong often
// enough to be useless — the official install script uses
// `/usr/local/etc/xray/config.json`, a package build uses `/etc/xray`, a
// systemd unit carries the real path in its `ExecStart` line, and a hand-made
// install has none of them.
//
// So one small `sh -c` script asks the host, and the answers come back as
// `key=value` lines. The script is assembled from constants and validated
// values only; it contains no single quote, so it survives being wrapped in
// one.

import { shellQuote } from "./shell.js";
import { isSafeUnit, serviceUnit } from "./validate.js";

/** Where a config file is usually found, in the order the host is asked. */
export const CONFIG_CANDIDATES = [
  "/usr/local/etc/xray/config.json",
  "/etc/xray/config.json",
  "/usr/local/share/xray/config.json",
  "/opt/xray/config.json",
];

const BIN_CANDIDATES = ["xray", "/usr/local/bin/xray", "/usr/bin/xray", "/opt/xray/xray"];

/**
 * The detection script. It never fails: every probe is guarded, and a missing
 * tool leaves its field empty rather than aborting the script, because a
 * partial answer still tells the panel what to show.
 *
 * The statements are separated by NEWLINES, not by semicolons: a compound
 * command such as `for …; do …; done` is not valid with a `;` after the
 * `do`, and the shell rejects the whole script with a syntax error before it
 * runs a single probe.
 */
export function detectScript() {
  const candidates = CONFIG_CANDIDATES.map((path) => `"${path}"`).join(" ");
  const bins = BIN_CANDIDATES.map((path) => `"${path}"`).join(" ");
  return [
    'bin=""',
    `for c in ${bins}; do`,
    '  if command -v "$c" >/dev/null 2>&1; then bin=$(command -v "$c"); break; fi',
    "done",
    'home="$HOME"',
    'unit=""',
    'systemctl="no"',
    'if command -v systemctl >/dev/null 2>&1; then',
    '  systemctl="yes"',
    '  unit=$(systemctl list-unit-files "xray*.service" --no-legend 2>/dev/null | cut -d" " -f1 | head -n 1)',
    '  if [ -z "$unit" ]; then unit="xray.service"; fi',
    "fi",
    'cfg=""',
    'if [ -n "$unit" ] && [ "$systemctl" = "yes" ]; then',
    '  es=$(systemctl show -p ExecStart --value "$unit" 2>/dev/null)',
    "  set -- $es",
    "  while [ $# -gt 0 ]; do",
    '    case "$1" in',
    "      -c|--config|-conf) cfg=$2; shift ;;",
    "    esac",
    "    shift",
    "  done",
    "fi",
    'if [ -z "$cfg" ] || [ ! -f "$cfg" ]; then',
    `  for p in ${candidates} "$home/.config/xray/config.json"; do`,
    '    if [ -f "$p" ]; then cfg=$p; break; fi',
    "  done",
    "fi",
    'writable="no"',
    'if [ -n "$cfg" ] && [ -w "$cfg" ]; then writable="yes"; fi',
    'readable="no"',
    'if [ -n "$cfg" ] && [ -r "$cfg" ]; then readable="yes"; fi',
    // The panel backs the config up next to it and replaces it by rename, so
    // the DIRECTORY has to be writable too. A file the user may write inside
    // a directory they may not is still a config the panel cannot change.
    'dir=""',
    'dirwritable="no"',
    'if [ -n "$cfg" ]; then',
    '  dir=${cfg%/*}',
    '  if [ -n "$dir" ] && [ -w "$dir" ]; then dirwritable="yes"; fi',
    "fi",
    'sudo="no"',
    'if command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then sudo="yes"; fi',
    'fetch=""',
    'if command -v curl >/dev/null 2>&1; then fetch="curl";',
    'elif command -v wget >/dev/null 2>&1; then fetch="wget"; fi',
    'proc=""',
    'if command -v ps >/dev/null 2>&1; then proc=$(ps -eo args= 2>/dev/null | grep "[x]ray" | head -n 1); fi',
    'printf "bin=%s\\n" "$bin"',
    'printf "home=%s\\n" "$home"',
    'printf "config=%s\\n" "$cfg"',
    'printf "unit=%s\\n" "$unit"',
    'printf "systemctl=%s\\n" "$systemctl"',
    'printf "writable=%s\\n" "$writable"',
    'printf "readable=%s\\n" "$readable"',
    'printf "dir=%s\\n" "$dir"',
    'printf "dirwritable=%s\\n" "$dirwritable"',
    'printf "sudo=%s\\n" "$sudo"',
    'printf "fetch=%s\\n" "$fetch"',
    'printf "proc=%s\\n" "$proc"',
  ].join("\n");
}

/** The detection command. */
export const detectCommand = () => `sh -c ${shellQuote(detectScript())}`;

/**
 * Reads the `key=value` block the detection script prints. Unknown keys are
 * ignored, so the script can grow without breaking an older panel.
 */
export function parseDetectOutput(text) {
  const result = {
    bin: "",
    home: "",
    config: "",
    unit: "",
    systemctl: false,
    writable: false,
    readable: false,
    dir: "",
    dirWritable: false,
    sudo: false,
    fetch: "",
    proc: "",
  };
  for (const line of String(text ?? "").split("\n")) {
    const index = line.indexOf("=");
    if (index <= 0) {
      continue;
    }
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim();
    switch (key) {
      case "bin":
        result.bin = value;
        break;
      case "home":
        result.home = value;
        break;
      case "config":
        result.config = value;
        break;
      case "unit":
        result.unit = value;
        break;
      case "systemctl":
        result.systemctl = value === "yes";
        break;
      case "writable":
        result.writable = value === "yes";
        break;
      case "readable":
        result.readable = value === "yes";
        break;
      case "dir":
        result.dir = value;
        break;
      case "dirwritable":
        result.dirWritable = value === "yes";
        break;
      case "sudo":
        result.sudo = value === "yes";
        break;
      case "fetch":
        result.fetch = value;
        break;
      case "proc":
        result.proc = value;
        break;
      default:
        break;
    }
  }
  return result;
}

/**
 * The service state. `systemctl is-active` exits non-zero when the unit is
 * stopped, which is a normal answer rather than a failure, so the caller
 * reads the output instead of the exit code.
 */
export const serviceStateCommand = (unit) =>
  `systemctl is-active ${serviceUnit(unit)} 2>/dev/null; systemctl is-enabled ${serviceUnit(unit)} 2>/dev/null`;

/**
 * The service state, or null when the unit name is not one the panel may put
 * on a command line. The caller shows "unknown" rather than failing.
 */
export const safeServiceStateCommand = (unit) =>
  isSafeUnit(unit) ? serviceStateCommand(unit) : null;

/** Reads the two lines the service state command prints. */
export function parseServiceState(text) {
  const lines = String(text ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return {
    active: lines[0] || "unknown",
    enabled: lines[1] || "unknown",
  };
}
