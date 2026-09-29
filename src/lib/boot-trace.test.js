import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { bootMark, listBootMarks } from "./boot-trace";

const readSource = (relativePath) =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");

describe("bootMark", () => {
  beforeEach(() => {
    vi.spyOn(console, "info").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete globalThis.window;
  });

  it("records milestones in order, with the page clock", () => {
    const before = listBootMarks().length;
    bootMark("first");
    bootMark("second");
    const added = listBootMarks().slice(before);
    expect(added.map((mark) => mark.stage)).toEqual(["first", "second"]);
    expect(added[0].pageMs).toBeGreaterThanOrEqual(0);
    expect(added[1].pageMs).toBeGreaterThanOrEqual(added[0].pageMs);
  });

  it("hands out copies, so callers cannot rewrite history", () => {
    bootMark("immutable");
    const snapshot = listBootMarks();
    snapshot[snapshot.length - 1].stage = "tampered";
    expect(listBootMarks().at(-1).stage).toBe("immutable");
  });

  it("forwards to the native timeline when running under Tauri", () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const invoke = vi.fn(() => Promise.resolve());
    globalThis.window = { __TAURI_INTERNALS__: { invoke } };
    bootMark("forwarded");
    expect(invoke).toHaveBeenCalledWith(
      "boot_trace",
      expect.objectContaining({ stage: "forwarded", pageMs: expect.any(Number) }),
    );
  });

  it("does not throw when the native side rejects or is missing", () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    globalThis.window = {
      __TAURI_INTERNALS__: { invoke: () => Promise.reject(new Error("no such command")) },
    };
    expect(() => bootMark("rejected")).not.toThrow();
    globalThis.window = {
      __TAURI_INTERNALS__: {
        invoke: () => {
          throw new Error("bridge not ready");
        },
      },
    };
    expect(() => bootMark("threw")).not.toThrow();
    delete globalThis.window;
    expect(() => bootMark("no-window")).not.toThrow();
  });
});

// The boot plumbing swallows every error on purpose (it must never break
// boot), which also means a renamed command fails *silently*: the page would
// stop reporting in and the hidden window would only appear when Rust's
// 8-second deadline fires. These checks read the sources on both sides of the
// bridge so that drift fails here instead.
describe("boot bridge wiring", () => {
  const libRs = readSource("../../src-tauri/src/lib.rs");
  const bootRs = readSource("../../src-tauri/src/boot.rs");
  const indexHtml = readSource("../../index.html");
  const bootTraceJs = readSource("./boot-trace.js");
  const tauriConf = JSON.parse(readSource("../../src-tauri/tauri.conf.json"));

  it("registers both commands the page calls", () => {
    expect(libRs).toContain("boot::boot_ready");
    expect(libRs).toContain("boot::boot_trace");
    expect(bootRs).toMatch(/pub fn boot_ready\(/);
    expect(bootRs).toMatch(/pub fn boot_trace\(/);
  });

  it("calls those commands under the same names", () => {
    expect(indexHtml).toContain('call("boot_ready"');
    expect(bootTraceJs).toContain('"boot_trace"');
  });

  it("sends the argument names the Rust commands take (camelCase on the wire)", () => {
    expect(bootRs).toMatch(
      /page_ms: Option<u64>,\s*background: Option<String>,\s*via: Option<String>/,
    );
    expect(indexHtml).toMatch(/pageMs:/);
    expect(indexHtml).toMatch(/background:/);
    expect(indexHtml).toMatch(/via:/);
    expect(bootRs).toMatch(/stage: String, page_ms: u64/);
    expect(bootTraceJs).toContain("{ stage, pageMs }");
  });

  it("only hides the window when something is guaranteed to show it", () => {
    const [main] = tauriConf.app.windows;
    expect(main.visible).toBe(false);
    // Page-side reveal and the native backstop must both exist.
    expect(indexHtml).toContain("boot_ready");
    expect(libRs).toContain("arm_reveal_deadline");
  });

  it("touches the splash only after its markup has been parsed", () => {
    // The English text used to be applied from <head>, where the splash did
    // not exist yet: `querySelector` returned null, the throw was swallowed,
    // and every non-Chinese locale saw the Chinese text.
    const markup = indexHtml.indexOf('<div id="boot-splash"');
    const usesSplash = indexHtml.indexOf('document.getElementById("boot-splash")');
    expect(markup).toBeGreaterThan(-1);
    expect(usesSplash).toBeGreaterThan(markup);
  });

  it("keeps the native tint in step with the splash background", () => {
    // `boot_ready` tints the window with these literals; the splash paints the
    // matching `--boot-bg`. If one moves without the other the first frame
    // after show() flashes the wrong colour.
    expect(indexHtml).toContain('dark ? "#0e1118" : "#e8ecf2"');
    expect(indexHtml).toContain("--boot-bg: #e8ecf2;");
    expect(indexHtml).toContain("--boot-bg: #0e1118;");
  });
});
