import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installFakeDom, uninstallFakeDom } from "../test/fake-dom.js";
import { dismissBootSplash } from "./boot-splash";

// The splash lives in index.html, outside React, so it is torn down by hand.
// The failure modes worth pinning are the ones that leave the app unusable:
// a splash that never leaves, or a second dismiss throwing on a node the
// first one already removed.
//
// `data-leaving` is asserted through `getAttribute` rather than `dataset`:
// the shared fake DOM implements attributes, not the dataset proxy, and the
// production code only ever writes the attribute.
const mountSplash = () => {
  const splash = document.createElement("div");
  splash.setAttribute("id", "boot-splash");
  document.body.appendChild(splash);
  return splash;
};

describe("dismissBootSplash", () => {
  beforeEach(() => {
    installFakeDom();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    uninstallFakeDom();
  });

  it("marks the splash as leaving immediately", () => {
    const splash = mountSplash();
    dismissBootSplash();
    expect(splash.getAttribute("data-leaving")).toBe("true");
  });

  it("removes the splash after the fade window", () => {
    mountSplash();
    dismissBootSplash();
    expect(document.getElementById("boot-splash")).not.toBeNull();
    vi.advanceTimersByTime(1000);
    expect(document.getElementById("boot-splash")).toBeNull();
  });

  it("removes the splash even when transitionend never fires", () => {
    // A background window or `prefers-reduced-motion` can skip the transition
    // entirely; the timer is what guarantees the app is never covered.
    mountSplash();
    dismissBootSplash();
    vi.advanceTimersByTime(1000);
    expect(document.getElementById("boot-splash")).toBeNull();
  });

  it("is idempotent across StrictMode's double effect", () => {
    mountSplash();
    expect(() => {
      dismissBootSplash();
      dismissBootSplash();
    }).not.toThrow();
    vi.advanceTimersByTime(1000);
    expect(document.getElementById("boot-splash")).toBeNull();
  });

  it("is a no-op when the splash is absent", () => {
    expect(() => dismissBootSplash()).not.toThrow();
  });
});
