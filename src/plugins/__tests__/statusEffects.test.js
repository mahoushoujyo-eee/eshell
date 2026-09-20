import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => {
    throw new Error("not in tests");
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

import { installFakeDom, uninstallFakeDom } from "../../test/fake-dom.js";
import { useStatusEffects } from "../status/effects";
import { renderHook } from "./testUtils.jsx";

const makeCtx = (overrides = {}) => ({
  activeSessionId: "session-alpha",
  currentNic: null,
  disconnectedSessions: {},
  showSftpPanel: false,
  showStatusPanel: true,
  statusEnabled: true,
  statusRefreshInterval: 5000,
  ...overrides,
});

beforeEach(() => {
  installFakeDom();
});

afterEach(() => {
  uninstallFakeDom();
});

describe("useStatusEffects polling gate", () => {
  it("polls immediately and then on the configured interval", async () => {
    vi.useFakeTimers();
    const refreshStatus = vi.fn(async () => {});
    const ctx = makeCtx();
    const utils = await renderHook(() => useStatusEffects(ctx, { refreshStatus }));
    await vi.advanceTimersByTimeAsync(0);
    expect(refreshStatus).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(refreshStatus).toHaveBeenCalledTimes(2);
    await utils.unmount();
    vi.useRealTimers();
  });

  it("clamps sub-3s intervals to 5000ms", async () => {
    vi.useFakeTimers();
    const refreshStatus = vi.fn(async () => {});
    const utils = await renderHook(() =>
      useStatusEffects(makeCtx({ statusRefreshInterval: 1000 }), { refreshStatus }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(refreshStatus).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3000);
    expect(refreshStatus).toHaveBeenCalledTimes(1); // 3000 < 5000: not yet
    await vi.advanceTimersByTimeAsync(2000);
    expect(refreshStatus).toHaveBeenCalledTimes(2);
    await utils.unmount();
    vi.useRealTimers();
  });

  // A poll is five SSH commands; on a slow link it outlasts the interval. A
  // fixed-cadence timer would fire anyway, stacking requests that each re-run
  // every probe and whose results are all discarded but the last.
  it("never overlaps polls when a refresh outlasts the interval", async () => {
    vi.useFakeTimers();
    let inFlight = 0;
    let maxInFlight = 0;
    const refreshStatus = vi.fn(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 3000));
      inFlight -= 1;
    });
    const utils = await renderHook(() =>
      useStatusEffects(makeCtx({ statusRefreshInterval: 1000 }), { refreshStatus }),
    );

    await vi.advanceTimersByTimeAsync(10000);

    expect(maxInFlight).toBe(1);
    // A sub-3s interval clamps to 5s, so the 3s poll leaves a 2s gap: two polls
    // finish and a third starts, where a fixed cadence would have fired ten times.
    expect(refreshStatus.mock.calls.length).toBeLessThanOrEqual(3);
    await utils.unmount();
    vi.useRealTimers();
  });

  it("keeps polling after a refresh rejects", async () => {
    vi.useFakeTimers();
    const refreshStatus = vi.fn(async () => {
      throw new Error("probe failed");
    });
    const utils = await renderHook(() => useStatusEffects(makeCtx(), { refreshStatus }));

    await vi.advanceTimersByTimeAsync(0);
    expect(refreshStatus).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(refreshStatus).toHaveBeenCalledTimes(2);
    await utils.unmount();
    vi.useRealTimers();
  });

  it("stops polling when the extension is disabled", async () => {
    vi.useFakeTimers();
    const refreshStatus = vi.fn(async () => {});
    const utils = await renderHook(() =>
      useStatusEffects(makeCtx({ statusEnabled: false }), { refreshStatus }),
    );
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10000);
    expect(refreshStatus).not.toHaveBeenCalled();
    await utils.unmount();
    vi.useRealTimers();
  });

  it("keeps the original sftp-or-status visibility condition", async () => {
    vi.useFakeTimers();
    const refreshStatus = vi.fn(async () => {});
    // SFTP visible alone still polls (it shows status context), matching the
    // pre-plugin behavior exactly.
    const utils = await renderHook(() =>
      useStatusEffects(makeCtx({ showSftpPanel: true, showStatusPanel: false }), {
        refreshStatus,
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(refreshStatus).toHaveBeenCalledTimes(1);
    await utils.unmount();

    // Neither visible: no polling at all.
    const refreshStatus2 = vi.fn(async () => {});
    const utils2 = await renderHook(() =>
      useStatusEffects(makeCtx({ showSftpPanel: false, showStatusPanel: false }), {
        refreshStatus: refreshStatus2,
      }),
    );
    await vi.advanceTimersByTimeAsync(10000);
    expect(refreshStatus2).not.toHaveBeenCalled();
    await utils2.unmount();
    vi.useRealTimers();
  });

  it("skips a disconnected session until reconnect", async () => {
    vi.useFakeTimers();
    const refreshStatus = vi.fn(async () => {});
    const utils = await renderHook(
      () =>
        useStatusEffects(
          makeCtx({ disconnectedSessions: { "session-alpha": "eof" } }),
          { refreshStatus },
        ),
    );
    await vi.advanceTimersByTimeAsync(10000);
    expect(refreshStatus).not.toHaveBeenCalled();
    await utils.unmount();
    vi.useRealTimers();
  });

  it("does nothing without an active session", async () => {
    vi.useFakeTimers();
    const refreshStatus = vi.fn(async () => {});
    const utils = await renderHook(() =>
      useStatusEffects(makeCtx({ activeSessionId: null }), { refreshStatus }),
    );
    await vi.advanceTimersByTimeAsync(10000);
    expect(refreshStatus).not.toHaveBeenCalled();
    await utils.unmount();
    vi.useRealTimers();
  });
});
