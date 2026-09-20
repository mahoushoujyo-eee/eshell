// Panel preferences: the choices that survive a restart, plus the CLI prefix.
//
// Stored through `eshell.storage`, which is namespaced per plugin id. Nothing
// host-owned is written, and nothing here is per-host: the prefix and the
// refresh interval belong to the panel, not to a session.

export const TABS = ["containers", "images", "volumes", "networks", "compose", "system", "events"];
export const LOG_TAIL_OPTIONS = [100, 200, 500, 1000, 5000];
export const AUTO_REFRESH_OPTIONS = [0, 5, 10, 30, 60];
export const EVENT_WINDOWS = ["10m", "30m", "1h", "6h", "24h"];

export function createPrefs(react) {
  const { useCallback, useEffect, useState } = react;

  return function usePrefs(storage) {
    const [tab, setTab] = useState(() => {
      const stored = storage.get("tab");
      return TABS.includes(stored) ? stored : "containers";
    });
    const [bin, setBin] = useState(() => String(storage.get("bin") || "docker"));
    const [binDraft, setBinDraft] = useState(bin);
    const [autoRefresh, setAutoRefresh] = useState(() => {
      const stored = Number(storage.get("autoRefresh"));
      return AUTO_REFRESH_OPTIONS.includes(stored) ? stored : 0;
    });
    const [statsEnabled, setStatsEnabled] = useState(() => storage.get("stats") === true);
    const [logTail, setLogTail] = useState(() => {
      const stored = Number(storage.get("logTail"));
      return LOG_TAIL_OPTIONS.includes(stored) ? stored : 200;
    });

    // Not persisted: these are per-visit view options, and restoring a filter
    // the user cannot see would make the list look wrong on the next launch.
    const [imagesAll, setImagesAll] = useState(false);
    const [imagesDangling, setImagesDangling] = useState(false);
    const [eventWindow, setEventWindow] = useState("30m");

    useEffect(() => {
      storage.set("tab", tab);
    }, [storage, tab]);
    useEffect(() => {
      storage.set("bin", bin);
    }, [storage, bin]);
    useEffect(() => {
      storage.set("autoRefresh", autoRefresh);
    }, [storage, autoRefresh]);
    useEffect(() => {
      storage.set("stats", statsEnabled);
    }, [storage, statsEnabled]);
    useEffect(() => {
      storage.set("logTail", logTail);
    }, [storage, logTail]);

    const applyBin = useCallback(() => setBin(binDraft.trim() || "docker"), [binDraft]);
    const resetBin = useCallback(() => {
      setBin("docker");
      setBinDraft("docker");
    }, []);

    return {
      tab,
      setTab,
      bin,
      binDraft,
      setBinDraft,
      applyBin,
      resetBin,
      autoRefresh,
      setAutoRefresh,
      statsEnabled,
      setStatsEnabled,
      logTail,
      setLogTail,
      imagesAll,
      setImagesAll,
      imagesDangling,
      setImagesDangling,
      eventWindow,
      setEventWindow,
    };
  };
}
