// Reading, writing and restarting the xray configuration.
//
// The write path is the delicate part, so it is deliberately explicit:
//
//   1. copy the config aside (`cp -p`), so the mode and the owner survive;
//   2. write the new JSON into the copy and move it over the original, which
//      is atomic within one directory — a half-written config is never left
//      behind for xray to read;
//   3. validate with `xray run -test -config`, which parses the file without
//      binding any port;
//   4. restore the copy when the validation fails, so a bad edit cannot take
//      the proxy down;
//   5. restart the service and report whether it came back.
//
// Step 3 is what makes this safe to expose in a UI: the panel can write a
// configuration it built, but it never lets xray start with one it could not
// parse.

import { heredoc, shellQuote, withPrivilege } from "./shell.js";
import { binaryPath, configPath, serviceUnit } from "./validate.js";

/** The suffix of the backup the panel keeps next to the config. */
export const BACKUP_SUFFIX = ".eshell-backup";
/** The suffix of the temporary file the panel writes through. */
export const TEMP_SUFFIX = ".eshell-tmp";

export const backupPath = (path) => `${path}${BACKUP_SUFFIX}`;
export const tempPath = (path) => `${path}${TEMP_SUFFIX}`;

/** Reads the config file. */
export const readConfigCommand = (path) => `cat ${shellQuote(path)}`;

/** Copies the config aside before it is touched. */
export const backupConfigCommand = (path, privilege) =>
  withPrivilege(`cp -p ${shellQuote(path)} ${shellQuote(backupPath(path))}`, privilege);

/**
 * Writes the config.
 *
 * The body travels on stdin through a quoted heredoc, so the shell performs
 * no expansion on it and the JSON is never interpreted as shell syntax. The
 * inner script copies the original first — `cp -p` keeps the mode and the
 * owner — and truncates that copy, so `mv` over the original lands a file
 * with the same permissions the operator had set.
 *
 * The paths inside the script are double-quoted, which means the path may not
 * contain anything the shell would act on. `configPath` refuses such a path
 * rather than writing a command that could do something else.
 */
export function writeConfigCommand({ path, json, privilege, delimiter }) {
  const target = configPath(path);
  const body = String(json ?? "");
  const temp = tempPath(target);
  const script = `cp -p "${target}" "${temp}" && cat > "${temp}" && mv -f "${temp}" "${target}"`;
  const command = withPrivilege(`sh -c ${shellQuote(script)}`, privilege);
  return heredoc(command, body, delimiter);
}

/** Puts the backup back over the config. */
export const restoreConfigCommand = (path, privilege) =>
  withPrivilege(
    `cp -p ${shellQuote(backupPath(path))} ${shellQuote(path)}`,
    privilege,
  );

/** Validates the config: xray parses it and exits without binding anything. */
export const testConfigCommand = ({ path, bin, privilege }) =>
  withPrivilege(
    `${shellQuote(binaryPath(bin))} run -test -config ${shellQuote(path)}`,
    privilege,
  );

/**
 * The pre-1.8 spelling of the same check. Some packaged builds are old
 * enough to only understand this one, and a wrong flag is the only difference
 * between "invalid config" and "no such flag".
 */
export const testConfigFallbackCommand = ({ path, bin, privilege }) =>
  withPrivilege(
    `${shellQuote(binaryPath(bin))} -test -config ${shellQuote(path)}`,
    privilege,
  );

/** Restarts the service, whichever manager the host has. */
export const restartCommand = ({ unit, privilege, systemctl = true }) =>
  withPrivilege(
    systemctl ? `systemctl restart ${serviceUnit(unit)}` : `service ${serviceUnit(unit)} restart`,
    privilege,
  );

/** The service manager's own view of the unit. */
export const serviceStatusCommand = ({ unit, systemctl = true }) =>
  systemctl
    ? `systemctl show -p ActiveState -p SubState -p MainPID --value ${serviceUnit(unit)}`
    : `service ${serviceUnit(unit)} status`;

/** The tail of the xray log, used for the observatory delay lines. */
export const logTailCommand = (path, lines = 200) =>
  `tail -n ${Math.max(1, Math.min(2000, Number(lines) || 200))} ${shellQuote(path)} 2>/dev/null`;

/**
 * A delimiter for the heredoc. It has to be absent from the body: a line of
 * the JSON that is exactly the delimiter would end the heredoc early and the
 * rest of the config would be executed as a command.
 */
export function heredocDelimiter(body, seed = "0") {
  let counter = 0;
  let delimiter = `XRAY_EOF_${seed}`;
  while (String(body ?? "").split("\n").includes(delimiter)) {
    counter += 1;
    delimiter = `XRAY_EOF_${seed}_${counter}`;
  }
  return delimiter;
}
