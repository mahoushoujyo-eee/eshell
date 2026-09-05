/**
 * ACP capability probe.
 *
 * Speaks raw ndjson JSON-RPC to one agent subprocess: `initialize` then
 * `session/new`, and dumps what comes back. Used to find out what a given agent
 * actually advertises (session modes, config options such as model / thought
 * level) before wiring UI for it, since ACP makes all of that optional.
 *
 * Usage: node scripts/acp-probe.mjs '<full command line>'
 *
 * Takes one shell command line rather than argv parts: the scoped package names
 * (`@agentclientprotocol/codex-acp`) embed a `/c` that cmd.exe would otherwise
 * consume as a switch, so the name must stay quoted inside the command line.
 */

import { spawn } from "node:child_process";

const commandLine = process.argv.slice(2).join(" ");
if (!commandLine) {
  console.error("usage: node scripts/acp-probe.mjs '<full command line>'");
  process.exit(2);
}

console.log(`[probe] ${commandLine}`);
const child = spawn(commandLine, { shell: true, stdio: ["pipe", "pipe", "pipe"] });

let nextId = 0;
const pending = new Map();

const send = (method, params) => {
  const id = ++nextId;
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
  });
};

const respond = (id, result) => {
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
};

const notifications = [];

let buffer = "";
child.stdout.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let index;
  while ((index = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      console.log("[non-json stdout]", line.slice(0, 300));
      continue;
    }
    if (message.id != null && (message.result !== undefined || message.error !== undefined)) {
      const entry = pending.get(message.id);
      pending.delete(message.id);
      if (entry) {
        if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
        else entry.resolve(message.result);
      }
      continue;
    }
    if (message.id != null && message.method) {
      // Agent → client request. Answer the few we must so the handshake can proceed.
      console.log(`[agent request] ${message.method}`);
      respond(message.id, {});
      continue;
    }
    if (message.method) {
      notifications.push(message.method);
    }
  }
});

// stderr is where agents put their own logs; keep it visible but bounded.
let stderrSeen = 0;
child.stderr.on("data", (chunk) => {
  if (stderrSeen > 4000) return;
  const text = chunk.toString("utf8");
  stderrSeen += text.length;
  process.stderr.write(text);
});

const dump = (label, value) => {
  console.log(`\n===== ${label} =====`);
  console.log(JSON.stringify(value, null, 2));
};

// Pulls out only what this probe exists to answer.
const summarize = (session) => {
  const options = session?.configOptions;
  console.log("\n===== VERDICT =====");
  console.log(`modes advertised        : ${session?.modes ? "YES" : "no"}`);
  if (session?.modes) {
    console.log(
      `  modes                 : ${(session.modes.availableModes || [])
        .map((m) => m.id)
        .join(", ")}  (current: ${session.modes.currentModeId})`,
    );
  }
  console.log(`configOptions advertised: ${Array.isArray(options) ? `YES (${options.length})` : "no"}`);
  for (const option of options || []) {
    const values =
      option.type === "select"
        ? ` values=[${(option.options || [])
            .flatMap((group) => group.options || [group])
            .map((v) => v.id ?? v.optionId ?? JSON.stringify(v))
            .join(", ")}] current=${option.currentValue}`
        : ` current=${option.currentValue}`;
    console.log(`  - id=${option.id} category=${option.category ?? "(none)"} type=${option.type} name="${option.name}"${values}`);
  }
};

const finish = (code) => {
  console.log(`\nnotifications seen: ${notifications.join(", ") || "(none)"}`);
  child.kill();
  process.exit(code);
};

setTimeout(() => {
  console.log("\n[probe timeout]");
  finish(1);
}, 180000);

try {
  const init = await send("initialize", {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    clientInfo: { name: "acp-probe", version: "0.0.0" },
  });
  dump("initialize", init);

  const session = await send("session/new", { cwd: process.cwd(), mcpServers: [] });
  dump("session/new", session);
  summarize(session);

  // Validate the `session/set_config_option` wire shape against the real agent.
  // Deliberately re-sends each option's CURRENT value: that exercises request
  // parsing and the response shape without changing any of the user's settings.
  const target = (session?.configOptions || []).find((option) => option.type === "select");
  if (target) {
    console.log(`\n===== set_config_option round-trip (${target.id} -> ${target.currentValue}) =====`);
    for (const shape of [
      { label: "value as object {value}", value: { value: target.currentValue } },
      { label: "value as bare string", value: target.currentValue },
    ]) {
      try {
        const result = await send("session/set_config_option", {
          sessionId: session.sessionId,
          configId: target.id,
          value: shape.value,
        });
        const count = Array.isArray(result?.configOptions) ? result.configOptions.length : "?";
        console.log(`  ${shape.label}: ACCEPTED (returned ${count} options)`);
      } catch (err) {
        console.log(`  ${shape.label}: REJECTED ${err.message.slice(0, 180)}`);
      }
    }
  } else {
    console.log("\n(no select option to round-trip)");
  }
  finish(0);
} catch (err) {
  console.log(`\n[probe error] ${err.message}`);
  finish(1);
}
