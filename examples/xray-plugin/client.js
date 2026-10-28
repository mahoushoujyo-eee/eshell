// The panel's data layer: every command it runs on the host.
//
// A non-zero exit becomes `{ ok: false, failure }` rather than a rejection, so
// the controller never has to distinguish "xray said no" from "the transport
// broke". A value that fails validation is different: the method REJECTS,
// because a path the builders refuse means the caller is wrong. Every method
// is `async`, so a refusal can never surface as a synchronous throw inside a
// React event handler.
//
// The write path is the one that matters. `applyConfig` backs the file up,
// writes it, asks xray to parse it, restores the backup when the parse fails,
// and only then restarts the service — so a configuration the panel built
// badly never reaches a running xray.

import * as commands from "./cli/config.js";
import {
  detectCommand,
  parseDetectOutput,
  parseServiceState,
  safeServiceStateCommand,
} from "./cli/detect.js";
import { directProbeCommand, fetchCommand, probeCommand } from "./cli/subscription.js";
import { isSafeBinPath, isSafeUnit } from "./cli/validate.js";
import { classifyFailure } from "./failures.js";
import { parseConfig } from "./parse/config.js";

const mergeOutput = (result) =>
  [
    String((result && result.stdout) || "").trimEnd(),
    String((result && result.stderr) || "").trimEnd(),
  ]
    .filter(Boolean)
    .join("\n");

export function createXrayClient(execute, clientOptions = {}) {
  const options = clientOptions || {};

  /** Runs a command and classifies the result. */
  const outcome = async (command) => {
    const result = await execute(command);
    return result.exitCode === 0
      ? { ok: true, output: mergeOutput(result), command, result }
      : { ok: false, failure: classifyFailure(result), output: mergeOutput(result), command };
  };

  /**
   * Runs a command whose non-zero exit is a normal answer — a stopped
   * service, a file that does not exist. The output is the answer, so the
   * exit code is not treated as a failure.
   */
  const raw = async (command) => {
    const result = await execute(command);
    return { ok: true, output: mergeOutput(result), exitCode: result.exitCode, command };
  };

  const self = {
    outcome,
    raw,

    /** Asks the host what it has: the binary, the config, the service. */
    detect: async () => {
      const result = await outcome(detectCommand());
      if (!result.ok) {
        return { ok: false, failure: result.failure, info: null };
      }
      return { ok: true, failure: null, info: parseDetectOutput(result.output) };
    },

    /** The xray version, as `1.8.24`. */
    version: async (bin) => {
      if (!isSafeBinPath(bin)) {
        return {
          ok: false,
          version: "",
          raw: "",
          failure: { kind: "error", message: "the binary path cannot be used safely" },
        };
      }
      const result = await outcome(`${bin} version`);
      const match = /Xray\s+([0-9][^\s(]*)/i.exec(result.output || "");
      return {
        ok: result.ok,
        version: match ? match[1] : "",
        raw: result.output,
        failure: result.ok ? null : result.failure,
      };
    },

    /** The service state: `active`, `inactive`, `failed`… */
    serviceState: async (unit) => {
      const command = safeServiceStateCommand(unit);
      if (!command) {
        return { ok: true, active: "unknown", enabled: "unknown", command: "" };
      }
      const result = await raw(command);
      return { ok: true, ...parseServiceState(result.output), command: result.command };
    },

    /** Reads and parses the config file. */
    readConfig: async (path) => {
      const result = await outcome(commands.readConfigCommand(path));
      if (!result.ok) {
        return { ok: false, config: null, failure: result.failure, command: result.command };
      }
      const parsed = parseConfig(result.output);
      if (!parsed.ok) {
        return {
          ok: false,
          config: null,
          failure: { kind: "invalidConfig", detail: parsed.error, message: parsed.error },
          command: result.command,
        };
      }
      return { ok: true, config: parsed.config, failure: null, command: result.command };
    },

    /**
     * Writes the config and restarts the service.
     *
     * Every step is reported, so the panel can show which one failed and the
     * host's own message. A failed validation restores the backup and stops
     * there: the service is not restarted onto a config xray could not read.
     */
    applyConfig: async ({ path, json, bin, privilege = "", unit = "", systemctl = true, restart = true }) => {
      const steps = [];
      const body = String(json ?? "");
      const delimiter = commands.heredocDelimiter(body, String(path.length));

      // The values that reach the command line are checked before anything is
      // written: a path the builders would refuse must not leave a half
      // applied config behind.
      if (!bin) {
        return {
          ok: false,
          failure: { kind: "missing", detail: "no xray binary to validate the config with" },
          steps,
          restored: false,
        };
      }
      if (!isSafeBinPath(bin)) {
        return {
          ok: false,
          failure: { kind: "error", message: "the binary path cannot be used safely" },
          steps,
          restored: false,
        };
      }
      if (restart && unit && !isSafeUnit(unit)) {
        return {
          ok: false,
          failure: { kind: "error", message: "the service name cannot be used safely" },
          steps,
          restored: false,
        };
      }

      const backup = await outcome(commands.backupConfigCommand(path, privilege));
      steps.push({ name: "backup", ok: backup.ok, output: backup.output });
      if (!backup.ok) {
        return { ok: false, failure: backup.failure, steps, restored: false };
      }

      const write = await outcome(
        commands.writeConfigCommand({ path, json: body, privilege, delimiter }),
      );
      steps.push({ name: "write", ok: write.ok, output: write.output });
      if (!write.ok) {
        const restore = await outcome(commands.restoreConfigCommand(path, privilege));
        steps.push({ name: "restore", ok: restore.ok, output: restore.output });
        return { ok: false, failure: write.failure, steps, restored: restore.ok };
      }

      let test = await outcome(commands.testConfigCommand({ path, bin, privilege }));
      if (!test.ok && /unknown flag|unknown shorthand|flag provided but not defined/i.test(test.output)) {
        // An older build spells the same check without the `run` subcommand.
        test = await outcome(commands.testConfigFallbackCommand({ path, bin, privilege }));
      }
      steps.push({ name: "validate", ok: test.ok, output: test.output });
      if (!test.ok) {
        const restore = await outcome(commands.restoreConfigCommand(path, privilege));
        steps.push({ name: "restore", ok: restore.ok, output: restore.output });
        return {
          ok: false,
          failure: { kind: "invalidConfig", detail: test.output },
          steps,
          restored: restore.ok,
        };
      }

      if (!restart || !unit) {
        return { ok: true, failure: null, steps, restarted: false };
      }

      const restartResult = await outcome(
        commands.restartCommand({ unit, privilege, systemctl }),
      );
      steps.push({ name: "restart", ok: restartResult.ok, output: restartResult.output });
      if (!restartResult.ok) {
        return { ok: false, failure: restartResult.failure, steps, restarted: false };
      }

      const state = await self.serviceState(unit);
      steps.push({ name: "state", ok: state.active === "active", output: state.active });
      if (state.active !== "active") {
        return {
          ok: false,
          failure: {
            kind: "service",
            detail: `the service is ${state.active} after the restart`,
          },
          steps,
          restarted: true,
        };
      }
      return { ok: true, failure: null, steps, restarted: true };
    },

    /** Downloads a subscription on the host. */
    fetchSubscription: async ({ url, tool = "curl", timeout = 30 }) => {
      const result = await outcome(fetchCommand({ url, tool, timeout }));
      if (!result.ok) {
        return { ok: false, text: "", failure: result.failure, command: result.command };
      }
      return { ok: true, text: result.output, failure: null, command: result.command };
    },

    /** Measures the latency of the live path, through the local SOCKS port. */
    probe: async ({ socksPort, url, timeout = 10 }) => {
      const command = socksPort
        ? probeCommand({ socksPort, url, timeout })
        : directProbeCommand({ url, timeout });
      const result = await outcome(command);
      if (!result.ok) {
        return { ok: false, delay: null, failure: result.failure, command: result.command };
      }
      const seconds = Number.parseFloat(String(result.output).trim());
      return {
        ok: true,
        delay: Number.isFinite(seconds) ? Math.round(seconds * 1000) : null,
        failure: null,
        command: result.command,
      };
    },

    /** The tail of the xray log, where the observatory writes its delays. */
    readLog: async (path, lines = 200) => {
      if (!path) {
        return { ok: true, text: "", failure: null };
      }
      const result = await raw(commands.logTailCommand(path, lines));
      return { ok: true, text: result.output, failure: null };
    },
  };

  return self;
}
