/**
 * ACP multi-session concurrency probe.
 *
 * Answers the two questions the panel's session model hangs on:
 *
 *   1. Can one agent subprocess hold two sessions at once, and does it run
 *      their prompt turns concurrently or serialise them?
 *   2. Does the agent advertise (and honour) `session/close`, so a closed tab
 *      can actually release the session instead of leaking it for the
 *      lifetime of the process?
 *
 * The panel currently keeps a single session per agent, which forces the user
 * to stop the whole process to switch conversations. Whether that can become
 * "one process, N sessions" depends entirely on this measurement: a serialising
 * agent would leave a background tab's turn blocked behind the foreground one.
 *
 * Usage: node scripts/acp-concurrency-probe.mjs '<full command line>'
 *   e.g. node scripts/acp-concurrency-probe.mjs claude-agent-acp
 *
 * Read-only in spirit: it creates sessions but never touches the user's files,
 * and it closes what it opened when the agent supports it.
 */

import { spawn } from "node:child_process";

const commandLine = process.argv.slice(2).join(" ") || "claude-agent-acp";
const PROMPT_A =
  "Do not use any tools. Reply with a numbered list of 12 very short " +
  "single-line facts about the history of the shell.";
const PROMPT_B =
  "Do not use any tools. Reply with a numbered list of 12 very short " +
  "single-line facts about the history of the keyboard.";

const PHASE_TIMEOUT_MS = 150000;
const TOTAL_TIMEOUT_MS = 240000;

console.log(`[probe] agent: ${commandLine}`);
const child = spawn(commandLine, { shell: true, stdio: ["pipe", "pipe", "pipe"] });

let nextId = 0;
const pending = new Map();
/** sessionId -> { updates, firstAt, lastAt, textChars, kinds } */
const sessions = new Map();
const startedAt = Date.now();
const now = () => Date.now() - startedAt;

const send = (method, params) => {
  const id = ++nextId;
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  console.log(`[${now()}ms] -> #${id} ${method}`);
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, method, at: now() });
  });
};

const reply = (id, result) => {
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
};

const replyError = (id, message) => {
  child.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message } })}\n`,
  );
};

const bucket = (sessionId) => {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      updates: 0,
      firstAt: null,
      lastAt: null,
      textChars: 0,
      kinds: new Map(),
    });
  }
  return sessions.get(sessionId);
};

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
      console.log(`[${now()}ms] [non-json stdout] ${line.slice(0, 200)}`);
      continue;
    }

    // Response to one of our requests.
    if (message.id != null && (message.result !== undefined || message.error !== undefined)) {
      const entry = pending.get(message.id);
      pending.delete(message.id);
      const label = entry ? entry.method : `#${message.id}`;
      if (message.error) {
        console.log(`[${now()}ms] <- #${message.id} ${label} ERROR: ${message.error.message}`);
        entry?.reject(new Error(`${label}: ${message.error.message}`));
      } else {
        console.log(`[${now()}ms] <- #${message.id} ${label} ok`);
        entry?.resolve(message.result);
      }
      continue;
    }

    // Agent -> client request. A permission request must be answered with a
    // valid outcome or the turn hangs; anything else gets an empty object so
    // the handshake can proceed.
    if (message.id != null && message.method) {
      const method = message.method;
      console.log(`[${now()}ms] [agent request] ${method}`);
      if (method === "session/request_permission") {
        reply(message.id, { outcome: { outcome: "cancelled" } });
      } else if (method === "fs/read_text_file" || method === "fs/write_text_file") {
        replyError(message.id, "probe does not touch the filesystem");
      } else {
        reply(message.id, {});
      }
      continue;
    }

    // session/update notification.
    if (message.method === "session/update") {
      const params = message.params || {};
      const sessionId = params.sessionId ?? "(none)";
      const update = params.update || {};
      const kind = update.sessionUpdate || "unknown";
      const state = bucket(sessionId);
      state.updates += 1;
      state.lastAt = now();
      if (state.firstAt == null) state.firstAt = now();
      state.kinds.set(kind, (state.kinds.get(kind) || 0) + 1);
      if (typeof update.content?.text === "string") state.textChars += update.content.text.length;
      if (state.updates <= 3) {
        console.log(`[${now()}ms] ~ update ${kind} on ${sessionId.slice(0, 8)}`);
      }
      continue;
    }

    if (message.method) {
      console.log(`[${now()}ms] [notification] ${message.method}`);
    }
  }
});

let stderrSeen = 0;
child.stderr.on("data", (chunk) => {
  if (stderrSeen > 4000) return;
  const text = chunk.toString("utf8");
  stderrSeen += text.length;
  process.stderr.write(text);
});

child.on("exit", (code) => console.log(`[${now()}ms] agent exited (${code})`));

// Heartbeat: without it a stalled turn looks exactly like a slow one, because
// the probe's own stdout is buffered by the calling shell.
const heartbeat = setInterval(() => {
  const parts = [...sessions].map(
    ([id, s]) => `${id.slice(0, 8)}=${s.updates}u/${s.textChars}c`,
  );
  const waiting = [...pending.values()].map((p) => p.method).join(",");
  console.log(`[${now()}ms] . sessions[${parts.join(" ")}] pending[${waiting || "-"}]`);
}, 10000);

const dump = (label, value) => {
  console.log(`\n===== ${label} =====`);
  console.log(JSON.stringify(value, null, 2));
};

const describeCaps = (init) => {
  const caps = init?.agentCapabilities || {};
  const sessionCaps = caps.sessionCapabilities || null;
  console.log("\n===== capability summary =====");
  console.log(`loadSession             : ${caps.loadSession ? "YES" : "no"}`);
  console.log(`promptCapabilities.image: ${caps.promptCapabilities?.image ? "YES" : "no"}`);
  console.log(`sessionCapabilities     : ${sessionCaps ? JSON.stringify(sessionCaps) : "(absent)"}`);
  console.log(`session/close advertised: ${sessionCaps?.close ? "YES" : "no"}`);
  console.log(`session/list  advertised: ${sessionCaps?.list ? "YES" : "no"}`);
  console.log(`session/delete advertised: ${sessionCaps?.delete ? "YES" : "no"}`);
};

const withTimeout = (promise, ms, label) =>
  Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);

const finish = (code) => {
  clearInterval(heartbeat);
  child.kill();
  // The agent may outlive the shell wrapper on Windows; do not wait for it.
  setTimeout(() => process.exit(code), 200);
};

setTimeout(() => {
  console.log("\n[probe total timeout]");
  finish(1);
}, TOTAL_TIMEOUT_MS);

const VERDICT = { closeAdvertised: false, closeWorked: null, concurrent: null };

try {
  const init = await withTimeout(
    send("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
      clientInfo: { name: "acp-concurrency-probe", version: "0.0.0" },
    }),
    PHASE_TIMEOUT_MS,
    "initialize",
  );
  describeCaps(init);
  VERDICT.closeAdvertised = Boolean(init?.agentCapabilities?.sessionCapabilities?.close);

  console.log("\n===== session/new #1 =====");
  const first = await withTimeout(
    send("session/new", { cwd: process.cwd(), mcpServers: [] }),
    PHASE_TIMEOUT_MS,
    "session/new #1",
  );
  console.log(`sessionId: ${first.sessionId}`);

  console.log("\n===== session/new #2 =====");
  const second = await withTimeout(
    send("session/new", { cwd: process.cwd(), mcpServers: [] }),
    PHASE_TIMEOUT_MS,
    "session/new #2",
  );
  console.log(`sessionId: ${second.sessionId}`);
  console.log(
    `\ntwo distinct sessions: ${first.sessionId !== second.sessionId ? "YES" : "NO (same id!)"}`,
  );

  // Fire prompt A, then prompt B shortly after. If the agent serialises turns,
  // B's first session/update cannot arrive before A resolves.
  console.log("\n===== concurrent prompts =====");
  console.log(`A -> ${first.sessionId}`);
  const promptA = send("session/prompt", {
    sessionId: first.sessionId,
    prompt: [{ type: "text", text: PROMPT_A }],
  });
  const aSentAt = now();

  await new Promise((resolve) => setTimeout(resolve, 800));
  console.log(`B -> ${second.sessionId}  (fired at ${now()}ms)`);
  const promptB = send("session/prompt", {
    sessionId: second.sessionId,
    prompt: [{ type: "text", text: PROMPT_B }],
  });
  const bSentAt = now();

  const settled = {};
  const track = (name, promise) =>
    promise.then(
      (value) => {
        settled[name] = { ok: true, at: now(), value };
        return value;
      },
      (error) => {
        settled[name] = { ok: false, at: now(), error: error.message };
        return null;
      },
    );

  const [, bResult] = await Promise.all([
    withTimeout(track("A", promptA), PHASE_TIMEOUT_MS, "prompt A"),
    withTimeout(track("B", promptB), PHASE_TIMEOUT_MS, "prompt B"),
  ]);

  console.log("\n===== timeline =====");
  for (const [name, sessionId] of [
    ["A", first.sessionId],
    ["B", second.sessionId],
  ]) {
    const state = sessions.get(sessionId) || { updates: 0, firstAt: null, lastAt: null };
    const done = settled[name];
    console.log(
      `${name}: sent=${name === "A" ? aSentAt : bSentAt}ms  firstUpdate=${state.firstAt}ms  ` +
        `lastUpdate=${state.lastAt}ms  updates=${state.updates}  ` +
        `settled=${done ? `${done.at}ms ${done.ok ? "ok" : `error(${done.error})`}` : "never"}`,
    );
    if (state.kinds) {
      console.log(`   kinds: ${[...state.kinds].map(([k, n]) => `${k}×${n}`).join(", ") || "(none)"}`);
    }
  }

  const aState = sessions.get(first.sessionId) || {};
  const bState = sessions.get(second.sessionId) || {};
  const aDone = settled.A?.at ?? Infinity;
  const bDone = settled.B?.at ?? Infinity;
  aState.firstAt ??= Infinity;
  bState.firstAt ??= Infinity;
  const overlap = aState.firstAt < bDone && bState.firstAt < aDone;
  VERDICT.concurrent = Boolean(overlap);
  console.log(
    `\nfirst updates: A@${aState.firstAt}ms  B@${bState.firstAt}ms   ` +
      `A settled@${aDone}ms  B settled@${bDone}ms`,
  );
  console.log(`-> turns overlapped: ${VERDICT.concurrent ? "YES (concurrent)" : "NO (serialised)"}`);
  console.log(`B prompt result: ${bResult ? JSON.stringify(bResult) : "(see above)"}`);

  // Does close actually release the session? Prompt it afterwards: a live
  // session should answer, a closed one should error.
  console.log("\n===== session/close on B =====");
  try {
    const closed = await withTimeout(
      send("session/close", { sessionId: second.sessionId }),
      60000,
      "session/close",
    );
    console.log(`session/close accepted: ${JSON.stringify(closed)}`);
    VERDICT.closeWorked = true;
  } catch (error) {
    console.log(`session/close rejected: ${error.message}`);
    VERDICT.closeWorked = false;
  }

  console.log("\n===== prompt on closed session B (expect error) =====");
  try {
    const afterClose = await withTimeout(
      send("session/prompt", {
        sessionId: second.sessionId,
        prompt: [{ type: "text", text: "Reply with exactly: hi" }],
      }),
      60000,
      "prompt after close",
    );
    console.log(`UNEXPECTED: closed session still answers: ${JSON.stringify(afterClose)}`);
  } catch (error) {
    console.log(`as expected, closed session rejected: ${error.message}`);
  }

  console.log("\n===== prompt on session A (expect ok) =====");
  try {
    const stillAlive = await withTimeout(
      send("session/prompt", {
        sessionId: first.sessionId,
        prompt: [{ type: "text", text: "Reply with exactly: alive" }],
      }),
      PHASE_TIMEOUT_MS,
      "prompt A after close of B",
    );
    console.log(`A still works: ${JSON.stringify(stillAlive)}`);
  } catch (error) {
    console.log(`A broken by closing B: ${error.message}`);
  }

  console.log("\n===== VERDICT =====");
  console.log(JSON.stringify(VERDICT, null, 2));
  finish(0);
} catch (error) {
  console.log(`\n[probe error] ${error.message}`);
  finish(1);
}
