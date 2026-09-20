// Listing state: the resource table, and the cluster metadata the header needs.
//
// Three invariants:
//
//  * A result is dropped when a newer request (or a session/context switch) has
//    superseded it — `requestRef` is the fence.
//  * Contexts, namespaces and the version are read once per (session, context),
//    not per listing: they change far less often than the rows.
//  * Every timer is cleared by the effect that created it, so leaving the panel
//    or opening a dialog stops the traffic.

const errorText = (error) => String((error && error.message) || error);

export function createListings(react) {
  const { useCallback, useEffect, useRef, useState } = react;

  return function useListings({ client, activeSessionId, descriptor, scopeKey, sortByAge, autoRefresh, paused }) {
    const [columns, setColumns] = useState([]);
    const [rows, setRows] = useState([]);
    const [note, setNote] = useState("");
    const [loading, setLoading] = useState(false);
    const [failure, setFailure] = useState(null);

    const [contexts, setContexts] = useState([]);
    const [currentContext, setCurrentContext] = useState("");
    const [namespaces, setNamespaces] = useState([]);
    const [version, setVersion] = useState(null);

    const requestRef = useRef(0);
    const hasSession = Boolean(activeSessionId);
    const kind = descriptor.kind;

    const load = useCallback(
      async ({ quiet = false } = {}) => {
        if (!hasSession) {
          setColumns([]);
          setRows([]);
          setFailure(null);
          return;
        }
        const token = ++requestRef.current;
        const fresh = () => token === requestRef.current;
        if (!quiet) {
          setLoading(true);
        }
        try {
          const result = await client.list(kind, {
            namespaced: descriptor.namespaced,
            sortBy: sortByAge ? ".metadata.creationTimestamp" : undefined,
          });
          if (!fresh()) return;
          setColumns(result.columns);
          setRows(result.rows);
          setNote(result.note || "");
          setFailure(result.ok ? null : result.failure);
        } catch (error) {
          if (fresh()) {
            setFailure({ kind: "error", message: errorText(error) });
          }
        } finally {
          if (fresh() && !quiet) {
            setLoading(false);
          }
        }
      },
      [client, descriptor.namespaced, hasSession, kind, sortByAge],
    );

    useEffect(() => {
      load();
    }, [load]);

    useEffect(() => {
      if (!autoRefresh || !hasSession || paused) {
        return undefined;
      }
      const timer = setInterval(() => load({ quiet: true }), autoRefresh * 1000);
      return () => clearInterval(timer);
    }, [autoRefresh, hasSession, load, paused]);

    // Cluster metadata: the context list comes from the kubeconfig, the
    // namespace list from the cluster, so the second one needs the first to
    // have resolved to something reachable.
    useEffect(() => {
      if (!hasSession) {
        setContexts([]);
        setNamespaces([]);
        setVersion(null);
        return undefined;
      }
      let cancelled = false;
      (async () => {
        try {
          const [contextResult, namespaceResult, versionResult] = await Promise.all([
            client.contexts(),
            client.namespaces(),
            client.version(),
          ]);
          if (cancelled) {
            return;
          }
          setContexts(contextResult.contexts);
          setCurrentContext(contextResult.current);
          setNamespaces(namespaceResult.namespaces);
          setVersion(versionResult.version);
        } catch {
          // The listing's own failure banner already explains an unusable host;
          // the header simply shows no pickers.
        }
      })();
      return () => {
        cancelled = true;
      };
      // `scopeKey` covers the session and the selected context: a new context
      // means a different kubeconfig entry, so both lists are re-read.
    }, [client, hasSession, scopeKey]);

    return {
      columns,
      rows,
      note,
      loading,
      failure,
      contexts,
      currentContext,
      namespaces,
      version,
      load,
      refresh: useCallback(() => load(), [load]),
    };
  };
}
