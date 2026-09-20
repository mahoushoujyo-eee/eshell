// Listing state: what each tab shows, and when it is re-read.
//
// Three invariants:
//
//  * A result is dropped when a newer request (or a session switch) has
//    superseded it — `requestRef` is the fence.
//  * Only the open tab is loaded. `docker system df` and `docker events` are
//    the expensive calls here and nothing else needs them.
//  * Every timer is cleared by the effect that created it, so leaving a tab or
//    opening a dialog stops the traffic.

const STATS_POLL_MS = 5000;
const errorText = (error) => String((error && error.message) || error);

export function createListings(react) {
  const { useCallback, useEffect, useRef, useState } = react;

  return function useListings({
    client,
    activeSessionId,
    tab,
    imagesAll,
    imagesDangling,
    eventWindow,
    statsEnabled,
    autoRefresh,
    paused,
  }) {
    const [containers, setContainers] = useState([]);
    const [stats, setStats] = useState([]);
    const [images, setImages] = useState([]);
    const [volumes, setVolumes] = useState([]);
    const [networks, setNetworks] = useState([]);
    const [composeProjects, setComposeProjects] = useState([]);
    const [composeFailure, setComposeFailure] = useState(null);
    const [events, setEvents] = useState([]);
    const [diskRows, setDiskRows] = useState([]);
    const [info, setInfo] = useState(null);
    const [version, setVersion] = useState(null);
    const [loading, setLoading] = useState(false);
    const [failure, setFailure] = useState(null);

    const requestRef = useRef(0);
    const hasSession = Boolean(activeSessionId);

    const clearAll = useCallback(() => {
      setContainers([]);
      setImages([]);
      setVolumes([]);
      setNetworks([]);
      setComposeProjects([]);
      setEvents([]);
      setDiskRows([]);
      setInfo(null);
      setVersion(null);
      setFailure(null);
    }, []);

    const loadTab = useCallback(
      async (which, { quiet = false } = {}) => {
        if (!hasSession) {
          clearAll();
          return;
        }
        const token = ++requestRef.current;
        const fresh = () => token === requestRef.current;
        if (!quiet) {
          setLoading(true);
        }
        try {
          if (which === "containers") {
            const result = await client.containers();
            if (!fresh()) return;
            setContainers(result.rows);
            setFailure(result.ok ? null : result.failure);
          } else if (which === "images") {
            const result = await client.images({ all: imagesAll, dangling: imagesDangling });
            if (!fresh()) return;
            setImages(result.rows);
            setFailure(result.ok ? null : result.failure);
          } else if (which === "volumes") {
            const result = await client.volumes();
            if (!fresh()) return;
            setVolumes(result.rows);
            setFailure(result.ok ? null : result.failure);
          } else if (which === "networks") {
            const result = await client.networks();
            if (!fresh()) return;
            setNetworks(result.rows);
            setFailure(result.ok ? null : result.failure);
          } else if (which === "compose") {
            // Containers carry the compose labels, so the grouping works even
            // when `docker compose ls` is unavailable; the project listing only
            // adds projects whose containers are gone.
            const [containerResult, projectResult] = await Promise.all([
              client.containers(),
              client.composeProjects(),
            ]);
            if (!fresh()) return;
            setContainers(containerResult.rows);
            setComposeProjects(projectResult.rows);
            setComposeFailure(projectResult.ok ? null : projectResult.failure);
            setFailure(containerResult.ok ? null : containerResult.failure);
          } else if (which === "system") {
            const [infoResult, versionResult, dfResult] = await Promise.all([
              client.info(),
              client.version(),
              client.diskUsage(),
            ]);
            if (!fresh()) return;
            setInfo(infoResult.info);
            setVersion(versionResult.version);
            setDiskRows(dfResult.rows);
            setFailure(infoResult.ok ? null : infoResult.failure);
          } else if (which === "events") {
            const result = await client.events({ since: eventWindow });
            if (!fresh()) return;
            setEvents(result.rows);
            setFailure(result.ok ? null : result.failure);
          }
        } catch (error) {
          if (!fresh()) return;
          setFailure({ kind: "error", message: errorText(error) });
        } finally {
          if (fresh() && !quiet) {
            setLoading(false);
          }
        }
      },
      [client, clearAll, eventWindow, hasSession, imagesAll, imagesDangling],
    );

    // Re-reads on tab change, session change, prefix change, and when a tab's
    // own options (image filters, event window) change — `loadTab`'s identity
    // carries all of those.
    useEffect(() => {
      loadTab(tab);
    }, [loadTab, tab]);

    useEffect(() => {
      if (!autoRefresh || !hasSession || paused) {
        return undefined;
      }
      const timer = setInterval(() => loadTab(tab, { quiet: true }), autoRefresh * 1000);
      return () => clearInterval(timer);
    }, [autoRefresh, hasSession, loadTab, paused, tab]);

    // `docker stats --no-stream` is one command per sample, so it only runs
    // while the containers tab is open and the toggle is on.
    useEffect(() => {
      if (!statsEnabled || !hasSession || tab !== "containers") {
        setStats([]);
        return undefined;
      }
      let cancelled = false;
      const sample = async () => {
        try {
          const result = await client.stats();
          if (!cancelled && result.ok) {
            setStats(result.rows);
          }
        } catch {
          // A failed sample keeps the previous numbers; the next tick retries.
        }
      };
      sample();
      const timer = setInterval(sample, STATS_POLL_MS);
      return () => {
        cancelled = true;
        clearInterval(timer);
      };
    }, [client, hasSession, statsEnabled, tab]);

    return {
      containers,
      stats,
      images,
      volumes,
      networks,
      composeProjects,
      composeFailure,
      events,
      diskRows,
      info,
      version,
      loading,
      failure,
      setFailure,
      loadTab,
      refresh: useCallback(() => loadTab(tab), [loadTab, tab]),
    };
  };
}
