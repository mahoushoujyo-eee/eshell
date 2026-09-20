// Generic bottom-panel visibility.
//
// One visibility map keyed by panel key replaces the hardcoded
// sftp/status/draft setters. Every old workbench key survives as a compat
// adapter over the same map (`showSftpPanel` -> `visibility.sftp`,
// `setShowSftpPanel` -> `setPanelVisible("sftp", value)`), so no existing
// consumer changes behavior:
//   - sftp / status / draft default to hidden, exactly as before;
//   - a disabled extension's panel is gone from the resolved list, so its
//     stale map entry is inert;
//   - an external panel appears on install only if it asked to, with an
//     explicit `defaultVisible: true`: the first resolve that sees its key
//     initializes it to visible once, in an effect (never during render).
//     Panels are opt-in because visibility is not persisted — a panel that
//     opened itself on install would reopen on every launch.
//
// `showPanel` / `hidePanel` / `togglePanel` are the general surface the
// plugin host context exposes; they accept any resolved panel key.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { resolvePanelContributions } from "../contributions";
import { getPlugin } from "../registry";
import { useRegistryVersion } from "./useRegistry";

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

/**
 * The visibility map plus the general and compat surfaces.
 * `extensions` is the workbench's extension state (manifest + enabled flags).
 */
export function usePanelVisibility(extensions) {
  // Re-resolve when the registry changes (a late external registration or a
  // disable). The version is a dependency of the panels memo below: without
  // it, a registration that lands after mount would never re-run the
  // first-seen default effect.
  const registryVersion = useRegistryVersion();

  const [visibility, setVisibility] = useState({});
  // Keys whose defaultVisible was already applied. An explicit hide after
  // that must stick: defaults apply exactly once per key.
  const defaultedKeysRef = useRef(new Set());

  const panels = useMemo(
    () => resolvePanelContributions(extensions).filter((panel) => panel.enabled),
    // registryVersion: the memo re-resolves on every registry change even
    // when the extensions array identity did not change (a late external
    // registration publishes through the registry, not the manifest).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [extensions, registryVersion],
  );

  // First-seen defaults, applied in an effect: an external panel that asked
  // for it (`defaultVisible: true`) appears on install; builtin panels stay
  // hidden (their plugin shapes carry no defaultVisible, and the pre-plugin
  // default was hidden). `builtin` comes from the plugin shape (`getPlugin`),
  // not contributions — `contributions.js` output stays untouched.
  useEffect(() => {
    const pending = panels.filter(
      (panel) =>
        getPlugin(panel.pluginId)?.builtin === false &&
        panel.defaultVisible === true &&
        !defaultedKeysRef.current.has(panel.key) &&
        !hasOwn(visibility, panel.key),
    );
    if (pending.length === 0) {
      return;
    }
    for (const panel of pending) {
      defaultedKeysRef.current.add(panel.key);
    }
    setVisibility((prev) => {
      let next = prev;
      for (const panel of pending) {
        if (!hasOwn(next, panel.key)) {
          next = { ...next, [panel.key]: true };
        }
      }
      return next;
    });
  }, [panels, visibility]);

  const setPanelVisible = useCallback((key, value) => {
    if (!key) {
      return;
    }
    setVisibility((prev) =>
      prev[key] === Boolean(value) ? prev : { ...prev, [key]: Boolean(value) },
    );
  }, []);

  const showPanel = useCallback((key) => setPanelVisible(key, true), [setPanelVisible]);
  const hidePanel = useCallback((key) => setPanelVisible(key, false), [setPanelVisible]);
  const togglePanel = useCallback(
    (key) => {
      if (!key) {
        return;
      }
      setVisibility((prev) => ({ ...prev, [key]: prev[key] !== true }));
    },
    [],
  );

  const isPanelVisible = useCallback(
    (key) => visibility[key] === true,
    [visibility],
  );

  // The resolved panel list is exposed for the dock (keys in layout order).
  return {
    visibility,
    panels,
    showPanel,
    hidePanel,
    togglePanel,
    setPanelVisible,
    isPanelVisible,
  };
}
