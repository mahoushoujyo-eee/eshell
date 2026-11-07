/**
 * The multi-conversation state machine, exercised through the hook's public
 * surface.
 *
 * What is pinned here is the part the old single-session model got wrong:
 * opening a conversation never stops another one, stream events go to the
 * conversation they belong to, `stopped` ends only the agent it came from, and
 * closing a tab releases exactly one conversation (the process only dies with
 * the last one).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invoke, streamRef } = vi.hoisted(() => ({
  invoke: vi.fn(),
  streamRef: { current: null },
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (_event, handler) => {
    streamRef.current = handler;
    return () => {};
  },
}));

import { act } from "react";
import { installFakeDom, uninstallFakeDom } from "../test/fake-dom.js";
import { renderHook } from "../test/react-render.js";
import { useAcpAgent } from "./useAcpAgent.js";

const AGENT_A = { id: "a", name: "Agent A", command: "npx", args: [], running: false, cwd: "/tmp" };
const AGENT_B = { id: "b", name: "Agent B", command: "npx", args: [], running: false, cwd: "/tmp" };

const NODE_PRESENT = {
  ok: true,
  node: { found: true, command: "node", version: "v22.0.0" },
  npx: { found: true, command: "npx", version: "10.0.0" },
};

const NODE_MISSING = {
  ok: false,
  node: { found: false, command: "node" },
  npx: { found: true, command: "npx", version: "10.0.0" },
};

const startInfo = (sessionId) => ({
  sessionId,
  modes: { availableModes: [], currentModeId: null },
  agentInfo: null,
  capabilities: { loadSession: true, promptImage: false, closeSession: true },
  cwd: "/tmp",
  configOptions: [],
  authRequired: false,
  resumed: false,
});

/**
 * Stateful backend stand-in: an agent is reported as `running` once started,
 * so the second conversation of the same agent takes the `acp_session_new`
 * path the way the real app does.
 */
function installBackend({ agents = [AGENT_A, AGENT_B] } = {}) {
  const running = new Set();
  let sessionSeq = 0;
  const calls = [];

  invoke.mockImplementation(async (command, args) => {
    calls.push({ command, args });
    switch (command) {
      case "acp_agent_list":
        return agents.map((agent) => ({ ...agent, running: running.has(agent.id) }));
      case "acp_agent_start": {
        const agentId = args?.input?.agentId;
        running.add(agentId);
        sessionSeq += 1;
        return startInfo(`sess-${agentId}-${sessionSeq}`);
      }
      case "acp_session_new": {
        const agentId = args?.input?.agentId;
        sessionSeq += 1;
        return startInfo(`sess-${agentId}-${sessionSeq}`);
      }
      case "acp_session_load": {
        const agentId = args?.input?.agentId;
        return { ...startInfo(args?.input?.sessionId), resumed: true };
      }
      case "acp_agent_stop": {
        running.delete(args?.input?.agentId);
        return undefined;
      }
      case "acp_runtime_env":
        return NODE_PRESENT;
      default:
        return [];
    }
  });

  return { calls, running };
}

const emit = async (payload) => {
  await act(async () => {
    streamRef.current({ payload });
  });
};

const started = async () => {
  const mounted = await renderHook(() => useAcpAgent());
  await act(async () => {
    await mounted.result.current.refreshAgents();
  });
  return mounted;
};

const conversationOf = (result, sessionId) =>
  result.current.conversations.find((row) => row.sessionId === sessionId);

beforeEach(() => {
  installFakeDom();
  invoke.mockReset();
  streamRef.current = null;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  uninstallFakeDom();
});

describe("runtime env probe", () => {
  it("only pushes the env-missing notice on the transition into missing", async () => {
    installBackend();
    invoke.mockImplementation(async (command) => {
      if (command === "acp_agent_list") {
        return [AGENT_A];
      }
      if (command === "acp_runtime_env") {
        return NODE_MISSING;
      }
      return [];
    });
    const { result, unmount } = await started();

    await act(async () => {
      await result.current.refreshRuntimeEnv();
    });
    await act(async () => {
      await result.current.refreshRuntimeEnv();
    });

    // With no conversation open the notice has nowhere to live in a
    // transcript, so it lands in the panel-level list.
    const notices = [...result.current.standaloneNotices, ...result.current.transcript].filter(
      (entry) => entry.code === "env-missing",
    );
    expect(notices).toHaveLength(1);
    expect(notices[0].detail).toBe("node");
    expect(notices[0].tone).toBe("warning");
    expect(result.current.envMissing).toBe(true);
    await unmount();
  });

  it("leaves runtimeEnv null when the probe throws", async () => {
    installBackend();
    invoke.mockRejectedValue(new Error("no tauri runtime"));
    const { result, unmount } = await renderHook(() => useAcpAgent());

    await act(async () => {
      await result.current.refreshRuntimeEnv();
    });

    expect(result.current.runtimeEnv).toBeNull();
    expect(result.current.envMissing).toBe(false);
    await unmount();
  });

  it("stays quiet when the toolchain is present", async () => {
    installBackend();
    const { result, unmount } = await started();

    await act(async () => {
      await result.current.refreshRuntimeEnv();
    });

    expect(result.current.envMissing).toBe(false);
    expect(
      [...result.current.standaloneNotices, ...result.current.transcript].filter(
        (entry) => entry.code === "env-missing",
      ),
    ).toHaveLength(0);
    await unmount();
  });
});

describe("failure dedupe", () => {
  it("suppresses a stopped event that repeats a failure just reported", async () => {
    vi.useFakeTimers();
    installBackend();
    const { result, unmount } = await started();
    await act(async () => {
      await result.current.openSession({ agentId: "a" });
    });
    const sessionId = result.current.activeConversation.sessionId;

    // The mode switch rejects: that is the failure being reported.
    invoke.mockRejectedValueOnce(new Error("nope"));
    await act(async () => {
      await result.current.setMode("plan");
    });
    const errorNotices = () =>
      conversationOf(result, sessionId).transcript.filter((entry) => entry.tone === "error");
    expect(errorNotices()).toHaveLength(1);

    // The stream then reports the same outage. Inside the window it is noise.
    await emit({ agentId: "a", stage: "stopped", error: "nope" });
    expect(errorNotices()).toHaveLength(1);
    expect(errorNotices()[0].code).toBe("mode-failed");

    await unmount();
  });

  it("reports the stopped error once the window has lapsed", async () => {
    vi.useFakeTimers();
    installBackend();
    const { result, unmount } = await started();
    await act(async () => {
      await result.current.openSession({ agentId: "a" });
    });
    const sessionId = result.current.activeConversation.sessionId;

    vi.setSystemTime(Date.now() + 6000);
    await emit({ agentId: "a", stage: "stopped", error: "boom" });

    const errors = conversationOf(result, sessionId).transcript.filter(
      (entry) => entry.tone === "error",
    );
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe("agent-error");
    expect(errors[0].detail).toBe("boom");

    await unmount();
  });
});

describe("multi-conversation lifecycle", () => {
  it("opens a second conversation without stopping the first", async () => {
    const { calls } = installBackend();
    const { result, unmount } = await started();

    await act(async () => {
      await result.current.openSession({ agentId: "a" });
    });
    const first = result.current.activeConversation;

    await act(async () => {
      await result.current.openSession({ agentId: "b" });
    });
    const second = result.current.activeConversation;

    expect(result.current.conversations).toHaveLength(2);
    expect(first.phase).toBe("ready");
    expect(second.phase).toBe("ready");
    expect(first.agentId).toBe("a");
    expect(second.agentId).toBe("b");
    // Nothing was stopped to get the second one going.
    expect(calls.some((call) => call.command === "acp_agent_stop")).toBe(false);
    await unmount();
  });

  it("opens a second conversation of the same agent on the live process", async () => {
    const { calls } = installBackend();
    const { result, unmount } = await started();

    await act(async () => {
      await result.current.openSession({ agentId: "a" });
    });
    await act(async () => {
      await result.current.openSession({ agentId: "a" });
    });

    const starts = calls.filter((call) => call.command === "acp_agent_start");
    const news = calls.filter((call) => call.command === "acp_session_new");
    expect(starts).toHaveLength(1);
    expect(news).toHaveLength(1);
    expect(result.current.conversations).toHaveLength(2);
    await unmount();
  });

  it("reuses the process while the agent list refresh is still in flight", async () => {
    // The window that used to break: `applyStartInfo` refreshes the agent list
    // asynchronously, so a second conversation opened before that refresh lands
    // still sees `running: false` in state and would spawn a second process
    // (which the backend refuses). The live-agent bookkeeping covers it.
    let hangLists = false;
    const calls = [];
    let sessionSeq = 0;
    invoke.mockImplementation((command, args) => {
      calls.push({ command, args });
      if (command === "acp_agent_list") {
        return hangLists
          ? new Promise(() => {})
          : Promise.resolve([{ ...AGENT_A, running: false }]);
      }
      if (command === "acp_agent_start" || command === "acp_session_new") {
        sessionSeq += 1;
        return Promise.resolve(startInfo(`s-${sessionSeq}`));
      }
      return Promise.resolve([]);
    });

    const { result, unmount } = await renderHook(() => useAcpAgent());
    hangLists = true;

    await act(async () => {
      await result.current.openSession({ agentId: "a" });
    });
    await act(async () => {
      await result.current.openSession({ agentId: "a" });
    });

    const starts = calls.filter((call) => call.command === "acp_agent_start");
    const news = calls.filter((call) => call.command === "acp_session_new");
    expect(starts).toHaveLength(1);
    expect(news).toHaveLength(1);
    await unmount();
  });

  it("falls back to the live process when a stale list makes start refuse", async () => {
    const calls = [];
    let sessionSeq = 0;
    invoke.mockImplementation((command, args) => {
      calls.push({ command, args });
      switch (command) {
        case "acp_agent_list":
          // A process is alive that the list does not know about.
          return Promise.resolve([{ ...AGENT_A, running: false }]);
        case "acp_agent_start":
          return Promise.reject(new Error("acp agent `a` already has an active session"));
        case "acp_session_new":
          sessionSeq += 1;
          return Promise.resolve(startInfo(`s-${sessionSeq}`));
        default:
          return Promise.resolve([]);
      }
    });

    const { result, unmount } = await renderHook(() => useAcpAgent());
    await act(async () => {
      await result.current.openSession({ agentId: "a" });
    });

    expect(result.current.conversations).toHaveLength(1);
    expect(result.current.activeConversation.phase).toBe("ready");
    expect(calls.some((call) => call.command === "acp_session_new")).toBe(true);
    await unmount();
  });

  it("routes stream updates by session id, not by agent", async () => {
    installBackend();
    const { result, unmount } = await started();

    await act(async () => {
      await result.current.openSession({ agentId: "a" });
    });
    const firstId = result.current.activeConversation.sessionId;
    await act(async () => {
      await result.current.openSession({ agentId: "a" });
    });
    const secondId = result.current.activeConversation.sessionId;

    await emit({ agentId: "a", sessionId: firstId, stage: "delta", chunk: "from first" });
    await emit({ agentId: "a", sessionId: secondId, stage: "delta", chunk: "from second" });

    const text = (sessionId) =>
      conversationOf(result, sessionId).transcript
        .filter((entry) => entry.type === "assistant")
        .map((entry) => entry.text)
        .join("");
    expect(text(firstId)).toBe("from first");
    expect(text(secondId)).toBe("from second");
    await unmount();
  });

  it("ends only the conversations of the agent that stopped", async () => {
    installBackend();
    const { result, unmount } = await started();

    await act(async () => {
      await result.current.openSession({ agentId: "a" });
    });
    const aSession = result.current.activeConversation.sessionId;
    await act(async () => {
      await result.current.openSession({ agentId: "b" });
    });
    const bSession = result.current.activeConversation.sessionId;

    // `stopped` carries a session id the backend happened to record last; the
    // hook must ignore it and end every conversation of that agent.
    await emit({ agentId: "a", sessionId: aSession, stage: "stopped", error: "" });

    expect(conversationOf(result, aSession).phase).toBe("ended");
    expect(conversationOf(result, aSession).ended).toBe(true);
    expect(conversationOf(result, bSession).phase).toBe("ready");
    await unmount();
  });

  it("closes one conversation without killing the shared process", async () => {
    const { calls } = installBackend();
    const { result, unmount } = await started();

    await act(async () => {
      await result.current.openSession({ agentId: "a" });
    });
    const first = result.current.activeConversation.key;
    await act(async () => {
      await result.current.openSession({ agentId: "a" });
    });

    await act(async () => {
      await result.current.closeSession(first);
    });

    expect(result.current.conversations).toHaveLength(1);
    expect(calls.filter((call) => call.command === "acp_session_close")).toHaveLength(1);
    expect(calls.some((call) => call.command === "acp_agent_stop")).toBe(false);
    await unmount();
  });

  it("stops the process when the last conversation of an agent closes", async () => {
    const { calls } = installBackend();
    const { result, unmount } = await started();

    await act(async () => {
      await result.current.openSession({ agentId: "a" });
    });
    const only = result.current.activeConversation.key;

    await act(async () => {
      await result.current.closeSession(only);
    });

    expect(result.current.conversations).toHaveLength(0);
    expect(result.current.activeKey).toBeNull();
    const stop = calls.find((call) => call.command === "acp_agent_stop");
    expect(stop?.args?.input?.agentId).toBe("a");
    await unmount();
  });

  it("focuses an already-open conversation instead of resuming it twice", async () => {
    const { calls } = installBackend();
    const { result, unmount } = await started();

    await act(async () => {
      await result.current.openSession({ agentId: "a" });
    });
    const conversation = result.current.activeConversation;
    const record = {
      id: conversation.sessionId,
      agentId: "a",
      title: "t",
      cwd: "/tmp",
      projectId: null,
    };

    await act(async () => {
      await result.current.resumeHistory(record);
    });

    expect(result.current.conversations).toHaveLength(1);
    expect(calls.some((call) => call.command === "acp_session_load")).toBe(false);
    await unmount();
  });
});

describe("permissions on a background conversation", () => {
  it("keeps the request in that conversation's transcript", async () => {
    installBackend();
    const { result, unmount } = await started();

    await act(async () => {
      await result.current.openSession({ agentId: "a" });
    });
    const aSession = result.current.activeConversation.sessionId;
    await act(async () => {
      await result.current.openSession({ agentId: "b" });
    });
    const bSession = result.current.activeConversation.sessionId;

    // A request on the background conversation arrives while B is in front.
    await emit({
      agentId: "a",
      sessionId: aSession,
      stage: "permission_request",
      permission: {
        requestId: "req-1",
        toolCall: { toolCallId: "t1", title: "execute_command", status: "pending" },
        options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }],
      },
    });

    const pending = (sessionId) =>
      conversationOf(result, sessionId).transcript.filter((entry) => entry.type === "permission");
    expect(pending(aSession)).toHaveLength(1);
    expect(pending(bSession)).toHaveLength(0);
    await unmount();
  });
});
