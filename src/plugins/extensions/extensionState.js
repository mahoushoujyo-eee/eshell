import { useCallback, useEffect, useRef, useState } from "react";
import { createPluginHostBridge } from "../../lib/plugin-host";
import { DEFAULT_BUILTIN_EXTENSION_MANIFEST } from "./builtinManifest";

// Extension state talks to the backend through the same private bridge the
// plugin facade uses (`src/lib/plugin-host.js`): this module (and all of
// `src/plugins`) stays free of direct `tauri-api` / `@tauri-apps/*`
// imports. The bridge instance is module-scoped: extension state is host
// bookkeeping, not a per-activation resource.
const hostBridge = createPluginHostBridge();

export const normalizeExtensionRecord = (record) => {
  if (!record || typeof record !== "object") return null;
  const id = String(record.id || "").trim();
  if (!id) return null;

  const contributes = record.contributes && typeof record.contributes === "object"
    ? record.contributes
    : {};
  const panels = Array.isArray(contributes.panels)
    ? contributes.panels.map((panel) => {
        if (!panel || typeof panel !== "object") return null;
        const panelId = String(panel.id || "").trim();
        if (!panelId) return null;
        return {
          id: panelId,
          order: Number.isFinite(Number(panel.order)) ? Number(panel.order) : 0,
        };
      }).filter(Boolean)
    : [];

  return {
    id,
    displayName: String(record.displayName || id),
    version: String(record.version || ""),
    apiVersion: Number.isFinite(Number(record.apiVersion)) ? Number(record.apiVersion) : null,
    builtin: record.builtin !== false,
    defaultEnabled: record.defaultEnabled !== false,
    enabled: record.enabled !== false,
    contributes: { panels },
  };
};

export const normalizeExtensionList = (list) =>
  (Array.isArray(list) ? list : []).map(normalizeExtensionRecord).filter(Boolean);

export const defaultExtensionState = () =>
  normalizeExtensionList(
    DEFAULT_BUILTIN_EXTENSION_MANIFEST.extensions.map((extension) => ({
      ...extension,
      enabled: extension.defaultEnabled !== false,
    })),
  );

// Preserve record identity when activation is unchanged. Built-in metadata is
// fixed for this app version; absent records are removed from discovery.
export const mergeExtensionRecords = (previous, next) => {
  const previousById = new Map(previous.map((record) => [record.id, record]));
  return next.map((record) => {
    const existing = previousById.get(record.id);
    return existing?.enabled === record.enabled ? existing : record;
  });
};

// ---------------------------------------------------------------------------
// Startup seeding.
//
// The loader (`src/plugins/loader.js`) fetches the merged catalog BEFORE the
// first React render and seeds it here, so a persisted-disabled builtin or
// external never flashes enabled UI: `useExtensionState` initializes from
// this snapshot instead of the manifest defaults. The seed is a REPLAYABLE
// latest snapshot, not consume-once: StrictMode double-invokes the
// initializer, remounts read it again, and every newer catalog application
// (an `extensions-changed` event, a confirmed toggle) overwrites it — a
// stale seed can never resurrect an outdated state over a newer one.
// ---------------------------------------------------------------------------
let seededSnapshot = null;

/**
 * Records the latest full catalog snapshot (merged builtin + external rows,
// `enabled` folded in). Called on every catalog application; newest wins.
 */
export const seedExtensionStateSnapshot = (catalog) => {
  if (!Array.isArray(catalog)) {
    return;
  }
  seededSnapshot = normalizeExtensionList(catalog);
};

/**
 * The latest seeded snapshot, or the manifest defaults before the loader
 * has applied anything. `useExtensionState`'s initializer reads this on
 * EVERY mount: replayable (StrictMode double-invocation, remounts), and
 * never older than the newest catalog application — a newer seed overwrites
 * an older one instead of being consumed by the first reader. The returned
 * records are fresh copies: a consumer mutating its snapshot cannot poison
 * the seed for the next mount.
 */
export const consumeSeededExtensionState = () =>
  seededSnapshot ? normalizeExtensionList(seededSnapshot) : defaultExtensionState();

/** Test hook: clears a pending seed. */
export const clearSeededExtensionState = () => {
  seededSnapshot = null;
};

export function useExtensionState() {
  const [extensions, setExtensions] = useState(consumeSeededExtensionState);
  const mountedRef = useRef(false);
  const revisionRef = useRef(0);
  const eventRevisionRef = useRef(0);
  const toggleQueueRef = useRef(Promise.resolve());

  const acceptRecords = useCallback((payload) => {
    if (!mountedRef.current || !Array.isArray(payload)) return;
    revisionRef.current += 1;
    const records = normalizeExtensionList(payload);
    // The seed cache follows the live state: a remount (or a StrictMode
    // double-invocation) must read the newest catalog, never the snapshot
    // the loader applied before a newer event landed.
    seedExtensionStateSnapshot(records);
    setExtensions((previous) => mergeExtensionRecords(previous, records));
  }, []);

  useEffect(() => {
    let disposed = false;
    let unlisten = null;
    mountedRef.current = true;
    revisionRef.current += 1;

    const initialize = async () => {
      // Invocation order alone is insufficient: registration is asynchronous.
      unlisten = await hostBridge
        .listenPluginEvent("extensions-changed", (event) => {
          if (disposed) return;
          eventRevisionRef.current += 1;
          acceptRecords(event?.payload);
        })
        .catch(() => null);
      if (disposed) {
        unlisten?.();
        return;
      }
      const revision = revisionRef.current;
      try {
        const records = await hostBridge.listExtensions();
        if (!disposed && revision === revisionRef.current) acceptRecords(records);
      } catch {
        // Plain-browser previews retain the shared manifest defaults (or the
        // loader's seeded snapshot, when one is still pending).
      }
    };
    void initialize();

    return () => {
      disposed = true;
      mountedRef.current = false;
      revisionRef.current += 1;
      unlisten?.();
    };
  }, [acceptRecords]);

  const setExtensionEnabled = useCallback((extensionId, enabled) => {
    // Serialize local mutations, but never block event delivery on a command.
    // A rejection leaves UI state untouched and does not poison the queue.
    const task = toggleQueueRef.current.then(async () => {
      revisionRef.current += 1;
      const eventRevision = eventRevisionRef.current;
      try {
        const descriptors = await hostBridge.setExtensionEnabled(
          extensionId,
          Boolean(enabled),
        );
        // The complete backend result is authoritative, not the requested bool.
        // A newer event must not be overwritten by a delayed command reply.
        if (eventRevision === eventRevisionRef.current) acceptRecords(descriptors);
        return descriptors;
      } finally {
        revisionRef.current += 1;
      }
    });
    toggleQueueRef.current = task.catch(() => {});
    return task;
  }, [acceptRecords]);

  const isEnabled = useCallback(
    (extensionId) => extensions.find((record) => record.id === extensionId)?.enabled === true,
    [extensions],
  );

  return { extensions, setExtensionEnabled, isEnabled };
}
