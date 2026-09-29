import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installFakeDom, uninstallFakeDom } from "../../test/fake-dom.js";
import { renderHook } from "./testUtils.jsx";
import { createForwardPlugin, FORWARD_EXTENSION_ID, FORWARD_PANEL_ID } from "../forward/index.jsx";
import { useForwardOperations } from "../forward/operations.js";

// The panel contract the registry consumes: id, panel key/order and a render
// function that survives being mounted before its controller publishes.
describe("forward plugin registration", () => {
  it("contributes the forward panel at order 30", () => {
    const plugin = createForwardPlugin({});
    expect(plugin.id).toBe(FORWARD_EXTENSION_ID);
    expect(plugin.panels()).toHaveLength(1);
    expect(plugin.panels()[0]).toMatchObject({
      id: FORWARD_PANEL_ID,
      key: "forward",
      order: 30,
    });
  });

  it("contributes a matching toolbar entry", () => {
    const plugin = createForwardPlugin({});
    expect(plugin.toolbar()).toHaveLength(1);
    expect(plugin.toolbar()[0]).toMatchObject({
      key: "forward",
      panelId: FORWARD_PANEL_ID,
      order: 30,
    });
  });

  it("renders without a session", () => {
    const plugin = createForwardPlugin({});
    const element = plugin.panels()[0].render({ sessionForwards: [] });
    expect(element).toBeTruthy();
  });
});

describe("forward operations", () => {
  beforeEach(() => {
    installFakeDom();
  });

  afterEach(() => {
    uninstallFakeDom();
  });

  it("does nothing without an API or an active session", async () => {
    const onError = vi.fn();
    const ctx = {
      api: undefined,
      activeSessionId: null,
      onError,
      setSessionForwards: vi.fn(),
      setLoadError: vi.fn(),
    };
    const mounted = await renderHook(() => useForwardOperations(ctx));

    await expect(
      mounted.current.createForward({ targetHost: "h", targetPort: 1 }),
    ).resolves.toBe(false);
    await expect(mounted.current.stopForward("id")).resolves.toBe(false);
    expect(onError).not.toHaveBeenCalled();
  });

  it("routes create through the facade with the active session and refreshes", async () => {
    const created = [];
    const listed = [];
    const api = {
      forward: {
        create: vi.fn(async (input) => {
          created.push(input);
          return { id: "f1" };
        }),
        list: vi.fn(async (sessionId) => {
          listed.push(sessionId);
          return [{ id: "f1" }];
        }),
      },
    };
    const ctx = {
      api,
      activeSessionId: "tab-1",
      onError: vi.fn(),
      setSessionForwards: vi.fn(),
      setLoadError: vi.fn(),
    };
    const mounted = await renderHook(() => useForwardOperations(ctx));

    const ok = await mounted.current.createForward({
      targetHost: "localhost",
      targetPort: 5432,
      bindHost: "127.0.0.1",
      bindPort: 0,
    });

    expect(ok).toBe(true);
    expect(created).toEqual([
      {
        sessionId: "tab-1",
        targetHost: "localhost",
        targetPort: 5432,
        bindHost: "127.0.0.1",
        bindPort: 0,
      },
    ]);
    expect(listed).toEqual(["tab-1"]);
    expect(ctx.setSessionForwards).toHaveBeenCalledWith("tab-1", [{ id: "f1" }]);
  });

  it("reports a failed create without throwing", async () => {
    const api = {
      forward: {
        create: vi.fn(async () => {
          throw new Error("bind failed");
        }),
        list: vi.fn(async () => []),
      },
    };
    const ctx = {
      api,
      activeSessionId: "tab-1",
      onError: vi.fn(),
      setSessionForwards: vi.fn(),
      setLoadError: vi.fn(),
    };
    const mounted = await renderHook(() => useForwardOperations(ctx));

    const created = await mounted.current.createForward({ targetHost: "h", targetPort: 1 });

    expect(created).toBe(false);
    expect(ctx.onError).toHaveBeenCalledWith(expect.any(Error));
    expect(ctx.setSessionForwards).not.toHaveBeenCalled();
  });

  it("surfaces a failed list in loadError instead of throwing", async () => {
    const api = {
      forward: {
        create: vi.fn(),
        list: vi.fn(async () => {
          throw new Error("backend down");
        }),
      },
    };
    const ctx = {
      api,
      activeSessionId: "tab-1",
      onError: vi.fn(),
      setSessionForwards: vi.fn(),
      setLoadError: vi.fn(),
    };
    const mounted = await renderHook(() => useForwardOperations(ctx));

    await expect(mounted.current.refreshForwards("tab-1")).resolves.toEqual([]);
    expect(ctx.setLoadError).toHaveBeenCalledWith(expect.any(Error));
  });
});
