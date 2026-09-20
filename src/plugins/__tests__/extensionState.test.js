import { afterEach, describe, expect, it, vi } from "vitest";

// The Tauri backend is not available in tests; the module under test must
// degrade to the manifest default without throwing.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => {
    throw new Error("not in tests");
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

import {
  DEFAULT_BUILTIN_EXTENSION_MANIFEST,
} from "../extensions/builtinManifest";
import {
  clearSeededExtensionState,
  consumeSeededExtensionState,
  defaultExtensionState,
  mergeExtensionRecords,
  normalizeExtensionList,
  normalizeExtensionRecord,
  seedExtensionStateSnapshot,
} from "../extensions/extensionState";

describe("builtin manifest", () => {
  it("carries the two builtin extensions in contract order", () => {
    const ids = DEFAULT_BUILTIN_EXTENSION_MANIFEST.extensions.map((item) => item.id);
    expect(ids).toEqual(["eshell.sftp", "eshell.server-monitor"]);
  });

  it("contributes the sftp panel at order 10 and status at 20", () => {
    const [sftp, monitor] = DEFAULT_BUILTIN_EXTENSION_MANIFEST.extensions;
    expect(sftp.contributes.panels).toEqual([{ id: "sftp", order: 10 }]);
    expect(monitor.contributes.panels).toEqual([{ id: "status", order: 20 }]);
  });

  it("defaults both extensions to enabled", () => {
    for (const extension of DEFAULT_BUILTIN_EXTENSION_MANIFEST.extensions) {
      expect(extension.defaultEnabled).toBe(true);
      expect(extension.builtin).toBe(true);
    }
  });
});

describe("normalizeExtensionRecord", () => {
  it("mirrors manifest fields and keeps the enabled flag", () => {
    const record = normalizeExtensionRecord({
      id: "eshell.sftp",
      displayName: "SFTP",
      version: "1.0.0",
      apiVersion: 1,
      builtin: true,
      defaultEnabled: true,
      enabled: true,
      contributes: { panels: [{ id: "sftp", order: 10 }] },
    });
    expect(record).toMatchObject({
      id: "eshell.sftp",
      displayName: "SFTP",
      enabled: true,
    });
    expect(record.contributes.panels).toEqual([{ id: "sftp", order: 10 }]);
  });

  it("treats missing enabled as enabled (default-on contract)", () => {
    const record = normalizeExtensionRecord({
      id: "eshell.sftp",
      contributes: { panels: [{ id: "sftp", order: 10 }] },
    });
    expect(record.enabled).toBe(true);
  });

  it("drops malformed rows instead of guessing", () => {
    expect(normalizeExtensionRecord(null)).toBeNull();
    expect(normalizeExtensionRecord({})).toBeNull();
    expect(normalizeExtensionRecord({ id: "  " })).toBeNull();
    expect(
      normalizeExtensionRecord({ id: "x", contributes: { panels: [{ no: "id" }] } }),
    ).toMatchObject({ id: "x", contributes: { panels: [] } });
  });
});

describe("normalizeExtensionList", () => {
  it("keeps order and filters nulls", () => {
    const list = normalizeExtensionList([
      { id: "a", enabled: true },
      null,
      { id: "b", enabled: false },
    ]);
    expect(list.map((item) => item.id)).toEqual(["a", "b"]);
    expect(list[1].enabled).toBe(false);
  });

  it("tolerates junk input", () => {
    expect(normalizeExtensionList(undefined)).toEqual([]);
    expect(normalizeExtensionList({ not: "an array" })).toEqual([]);
  });
});

describe("mergeExtensionRecords", () => {
  const previous = defaultExtensionState();

  it("preserves identity when nothing changed", () => {
    const next = normalizeExtensionList(
      DEFAULT_BUILTIN_EXTENSION_MANIFEST.extensions.map((extension) => ({
        ...extension,
        enabled: true,
      })),
    );
    const merged = mergeExtensionRecords(previous, next);
    expect(merged).toEqual(previous);
  });

  it("adopts a changed enabled flag", () => {
    const next = normalizeExtensionList(
      DEFAULT_BUILTIN_EXTENSION_MANIFEST.extensions.map((extension) => ({
        ...extension,
        enabled: extension.id !== "eshell.sftp",
      })),
    );
    const merged = mergeExtensionRecords(previous, next);
    expect(merged.find((item) => item.id === "eshell.sftp").enabled).toBe(false);
    expect(merged.find((item) => item.id === "eshell.server-monitor").enabled).toBe(true);
  });

  it("drops extensions that disappeared from the payload", () => {
    const next = normalizeExtensionList([{ id: "eshell.sftp", enabled: true }]);
    const merged = mergeExtensionRecords(previous, next);
    expect(merged.map((item) => item.id)).toEqual(["eshell.sftp"]);
  });
});

describe("defaultExtensionState", () => {
  it("is manifest order with everything enabled", () => {
    const state = defaultExtensionState();
    expect(state.map((item) => item.id)).toEqual([
      "eshell.sftp",
      "eshell.server-monitor",
    ]);
    expect(state.every((item) => item.enabled)).toBe(true);
    expect(state.every((item) => item.defaultEnabled)).toBe(true);
  });
});

describe("startup seeding (replayable latest snapshot)", () => {
  const rows = (sftpEnabled = true) =>
    normalizeExtensionList([
      {
        id: "eshell.sftp",
        displayName: "SFTP",
        version: "1.0.0",
        apiVersion: 1,
        builtin: true,
        defaultEnabled: true,
        enabled: sftpEnabled,
        contributes: { panels: [{ id: "sftp", order: 10 }] },
      },
      {
        id: "eshell.server-monitor",
        displayName: "Server Monitor",
        version: "1.0.0",
        apiVersion: 1,
        builtin: true,
        defaultEnabled: true,
        enabled: true,
        contributes: { panels: [{ id: "status", order: 20 }] },
      },
    ]);

  afterEach(() => {
    clearSeededExtensionState();
  });

  it("a persisted-disabled row never flashes enabled at mount", () => {
    seedExtensionStateSnapshot(rows(false));
    const first = consumeSeededExtensionState();
    expect(first.find((item) => item.id === "eshell.sftp").enabled).toBe(false);
  });

  it("StrictMode double-invocation reads the same snapshot twice", () => {
    seedExtensionStateSnapshot(rows(false));
    // React StrictMode calls the useState initializer twice; the second call
    // must see the same (not consumed-away) snapshot.
    const first = consumeSeededExtensionState();
    const second = consumeSeededExtensionState();
    expect(first).toEqual(second);
    expect(second.find((item) => item.id === "eshell.sftp").enabled).toBe(false);
  });

  it("a newer seed overwrites an older one (no stale resurrection)", () => {
    seedExtensionStateSnapshot(rows(true));
    seedExtensionStateSnapshot(rows(false));
    const state = consumeSeededExtensionState();
    expect(state.find((item) => item.id === "eshell.sftp").enabled).toBe(false);
  });

  it("falls back to the manifest defaults before anything is seeded", () => {
    clearSeededExtensionState();
    const state = consumeSeededExtensionState();
    expect(state.map((item) => item.id)).toEqual([
      "eshell.sftp",
      "eshell.server-monitor",
    ]);
    expect(state.every((item) => item.enabled)).toBe(true);
  });

  it("the returned snapshot is a copy: mutating it cannot poison the seed", () => {
    seedExtensionStateSnapshot(rows(false));
    const snapshot = consumeSeededExtensionState();
    snapshot[0].enabled = true;
    expect(consumeSeededExtensionState().find((item) => item.id === "eshell.sftp").enabled)
      .toBe(false);
  });
});
