// Panel preferences: the choices that survive a restart.
//
// The context and the namespace are part of this: they are passed as
// `--context` / `-n` on every command, so remembering them changes nothing on
// the host — unlike `kubectl config use-context`, which would change what every
// other user of that machine sees.

export const AUTO_REFRESH_OPTIONS = [0, 5, 10, 30, 60];
export const LOG_TAIL_OPTIONS = [100, 200, 500, 1000, 5000];
export const SINCE_OPTIONS = ["", "5m", "15m", "1h", "6h", "24h"];

export function createPrefs(react) {
  const { useCallback, useEffect, useState } = react;

  return function usePrefs(storage) {
    const [bin, setBin] = useState(() => String(storage.get("bin") || "kubectl"));
    const [binDraft, setBinDraft] = useState(bin);
    const [kindKey, setKindKey] = useState(() => String(storage.get("kind") || "pods"));
    const [context, setContext] = useState(() => String(storage.get("context") || ""));
    const [namespace, setNamespace] = useState(() => String(storage.get("namespace") || ""));
    const [allNamespaces, setAllNamespaces] = useState(() => storage.get("allNamespaces") === true);
    const [autoRefresh, setAutoRefresh] = useState(() => {
      const stored = Number(storage.get("autoRefresh"));
      return AUTO_REFRESH_OPTIONS.includes(stored) ? stored : 0;
    });
    const [logTail, setLogTail] = useState(() => {
      const stored = Number(storage.get("logTail"));
      return LOG_TAIL_OPTIONS.includes(stored) ? stored : 200;
    });
    const [hideNoisy, setHideNoisy] = useState(() => storage.get("hideNoisy") !== false);
    const [sortByAge, setSortByAge] = useState(() => storage.get("sortByAge") === true);

    // One effect per stored key, written out rather than looped: hooks in a loop
    // would make the hook order depend on the data.
    useEffect(() => {
      storage.set("bin", bin);
    }, [storage, bin]);
    useEffect(() => {
      storage.set("kind", kindKey);
    }, [storage, kindKey]);
    useEffect(() => {
      storage.set("context", context);
    }, [storage, context]);
    useEffect(() => {
      storage.set("namespace", namespace);
    }, [storage, namespace]);
    useEffect(() => {
      storage.set("allNamespaces", allNamespaces);
    }, [storage, allNamespaces]);
    useEffect(() => {
      storage.set("autoRefresh", autoRefresh);
    }, [storage, autoRefresh]);
    useEffect(() => {
      storage.set("logTail", logTail);
    }, [storage, logTail]);
    useEffect(() => {
      storage.set("hideNoisy", hideNoisy);
    }, [storage, hideNoisy]);
    useEffect(() => {
      storage.set("sortByAge", sortByAge);
    }, [storage, sortByAge]);

    const applyBin = useCallback(() => setBin(binDraft.trim() || "kubectl"), [binDraft]);
    const resetBin = useCallback(() => {
      setBin("kubectl");
      setBinDraft("kubectl");
    }, []);

    return {
      bin,
      binDraft,
      setBinDraft,
      applyBin,
      resetBin,
      kindKey,
      setKindKey,
      context,
      setContext,
      namespace,
      setNamespace,
      allNamespaces,
      setAllNamespaces,
      autoRefresh,
      setAutoRefresh,
      logTail,
      setLogTail,
      hideNoisy,
      setHideNoisy,
      sortByAge,
      setSortByAge,
    };
  };
}
