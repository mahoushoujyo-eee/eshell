/**
 * The Node.js probe and the failure dedupe are both pure state machines
 * hanging off `acp_runtime_env` and the notice stream, so they are tested
 * through the hook's public surface rather than through the panel.
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

const AGENT = { id: "a", name: "Agent", command: "npx", args: [], running: false, cwd: "/tmp" };

const START_INFO = {
  sessionId: "s1",
  modes: { availableModes: [], currentModeId: null },
  agentInfo: null,
  capabilities: null,
  cwd: "/tmp",
  configOptions: [],
  authRequired: false,
  resumed: false,
};

const NODE_MISSING = {
  ok: false,
  node: { found: false, command: "node" },
  npx: { found: true, command: "npx", version: "10.0.0" },
};

const NODE_PRESENT = {
  ok: true,
  node: { found: true, command: "node", version: "v22.0.0" },
  npx: { found: true, command: "npx", version: "10.0.0" },
};

function respond(runtimeEnv) {
  return async (command) => {
    switch (command) {
      case "acp_agent_list":
        return [AGENT];
      case "acp_agent_start":
        return START_INFO;
      case "acp_runtime_env":
        return runtimeEnv;
      default:
        return [];
    }
  };
}

const errorNotices = (transcript) => transcript.filter((entry) => entry.tone === "error");

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
    invoke.mockImplementation(respond(NODE_MISSING));
    const { result, unmount } = await renderHook(() => useAcpAgent());

    await act(async () => {
      await result.current.refreshRuntimeEnv();
    });
    await act(async () => {
      await result.current.refreshRuntimeEnv();
    });

    const notices = result.current.transcript.filter((entry) => entry.code === "env-missing");
    expect(notices).toHaveLength(1);
    expect(notices[0].detail).toBe("node");
    expect(notices[0].tone).toBe("warning");
    expect(result.current.envMissing).toBe(true);
    await unmount();
  });

  it("leaves runtimeEnv null when the probe throws", async () => {
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
    invoke.mockImplementation(respond(NODE_PRESENT));
    const { result, unmount } = await renderHook(() => useAcpAgent());

    await act(async () => {
      await result.current.refreshRuntimeEnv();
    });

    expect(result.current.envMissing).toBe(false);
    expect(result.current.transcript.filter((entry) => entry.code === "env-missing")).toHaveLength(0);
    await unmount();
  });
});

describe("failure dedupe", () => {
  /** Mounts with a live session, so stream events pass the engaged-agent filter. */
  async function startedHook() {
    invoke.mockImplementation(respond(NODE_PRESENT));
    const mounted = await renderHook(() => useAcpAgent());
    await act(async () => {
      await mounted.result.current.refreshAgents();
    });
    await act(async () => {
      await mounted.result.current.start();
    });
    return mounted;
  }

  it("suppresses a stopped event that repeats a failure just reported", async () => {
    vi.useFakeTimers();
    const { result, unmount } = await startedHook();

    // The mode switch rejects: that is the failure being reported.
    invoke.mockRejectedValueOnce(new Error("nope"));
    await act(async () => {
      await result.current.setMode("plan");
    });
    expect(errorNotices(result.current.transcript)).toHaveLength(1);

    // The stream then reports the same outage. Inside the window it is noise,
    // and the event is still delivered because the agent is engaged.
    await act(async () => {
      streamRef.current({ payload: { agentId: "a", stage: "stopped", error: "nope" } });
    });
    const afterFirstStop = errorNotices(result.current.transcript);
    expect(afterFirstStop).toHaveLength(1);
    expect(afterFirstStop[0].code).toBe("mode-failed");

    await unmount();
  });

  it("reports the stopped error once the window has lapsed", async () => {
    vi.useFakeTimers();
    const { result, unmount } = await startedHook();

    vi.setSystemTime(Date.now() + 6000);
    await act(async () => {
      streamRef.current({ payload: { agentId: "a", stage: "stopped", error: "boom" } });
    });

    const errors = errorNotices(result.current.transcript);
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe("agent-error");
    expect(errors[0].detail).toBe("boom");

    await unmount();
  });
});
