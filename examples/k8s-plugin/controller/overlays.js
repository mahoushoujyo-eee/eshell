// Overlay state: the sheets (logs, describe, yaml, a parsed table, the exec
// console), the modals, and the confirmation request.
//
// Each opener sets `{ kind, token, … }` with `pending: true`, then patches the
// same sheet once its command returns — and only if the sheet is still the one
// that was opened, so a slow describe cannot overwrite a log view the user
// opened afterwards.

const LOG_POLL_MS = 3000;
const errorText = (error) => String((error && error.message) || error);

export function createOverlayState(react) {
  const { useCallback, useEffect, useRef, useState } = react;

  return function useOverlays({ client, prefs, scopeKey, say }) {
    const [sheet, setSheet] = useState(null);
    const [modal, setModal] = useState(null);
    const [confirm, setConfirm] = useState(null);

    // Log view options: per-visit, except the tail size, which lives in prefs.
    const [logContainer, setLogContainer] = useState("");
    const [logContainers, setLogContainers] = useState([]);
    const [logSince, setLogSince] = useState("");
    const [logTimestamps, setLogTimestamps] = useState(false);
    const [logPrevious, setLogPrevious] = useState(false);
    const [logFollow, setLogFollow] = useState(false);
    const [logFilter, setLogFilter] = useState("");
    const [logWrap, setLogWrap] = useState(true);

    const [execState, setExecState] = useState(null);

    const closeSheet = useCallback(() => setSheet(null), []);
    const closeModal = useCallback(() => setModal(null), []);
    const closeConfirm = useCallback(() => setConfirm(null), []);
    const runConfirm = useCallback(() => {
      // Read, clear, then run: the request is dropped before its action starts,
      // so a second click cannot fire the same destructive command twice.
      const request = confirm;
      setConfirm(null);
      request?.run?.();
    }, [confirm]);

    // A new session or context invalidates every overlay: its content came from
    // a cluster the panel is no longer looking at.
    useEffect(() => {
      setSheet(null);
      setModal(null);
      setConfirm(null);
      setLogFollow(false);
    }, [scopeKey]);

    const patchSheet = useCallback((kind, token, patch) => {
      setSheet((current) =>
        current && current.kind === kind && current.token === token
          ? { ...current, ...patch }
          : current,
      );
    }, []);

    /**
     * A client bound to one object's own namespace. A row read with `-A` came
     * from some other namespace than the panel's selection, and `kubectl logs`
     * and `kubectl exec` cannot address a single object across all of them.
     */
    const scopedClient = useCallback(
      (namespace) =>
        namespace ? client.withScope({ namespace, allNamespaces: false }) : client,
      [client],
    );

    // --- logs -------------------------------------------------------------
    const readLogs = useCallback(
      (target, container) => {
        const scoped = scopedClient(target.namespace);
        const logOptions = {
          tail: prefs.logTail,
          since: logSince || undefined,
          timestamps: logTimestamps,
          previous: logPrevious,
          container: container || undefined,
          allContainers: !container,
        };
        return target.pod
          ? scoped.logs(target.pod, logOptions)
          : scoped.workloadLogs(target.kind, target.name, logOptions);
      },
      [scopedClient, prefs.logTail, logSince, logTimestamps, logPrevious],
    );

    const openLogs = useCallback(
      async (target) => {
        const token = `${target.title}:${Date.now()}`;
        setLogFollow(false);
        setLogFilter("");
        setLogPrevious(false);
        setLogContainer("");
        setLogContainers([]);
        setSheet({ kind: "logs", token, target, text: "", pending: true });
        // The container list is only known for a pod, and only matters there:
        // `kubectl logs deployment/x` already fans out with --all-containers.
        if (target.pod) {
          scopedClient(target.namespace)
            .containers(target.pod)
            .then((result) => {
              if (result.ok) {
                setLogContainers(result.containers);
              }
            })
            .catch(() => {});
        }
        try {
          const result = await readLogs(target, "");
          patchSheet("logs", token, { text: result.text, pending: false });
        } catch (error) {
          patchSheet("logs", token, { text: errorText(error), pending: false });
        }
      },
      [patchSheet, readLogs, scopedClient],
    );

    const reloadLogs = useCallback(async () => {
      if (!sheet || sheet.kind !== "logs") {
        return;
      }
      const { token, target } = sheet;
      try {
        const result = await readLogs(target, logContainer);
        patchSheet("logs", token, { text: result.text, pending: false });
      } catch (error) {
        say("danger", errorText(error));
      }
    }, [logContainer, patchSheet, readLogs, say, sheet]);

    // Re-read when a log option changes while the sheet is open, so the toggles
    // act on the content instead of only on the next manual reload. The first
    // run for a token is skipped: `openLogs` already did that read.
    const logToken = sheet && sheet.kind === "logs" ? sheet.token : null;
    const loadedTokenRef = useRef(null);
    useEffect(() => {
      if (!logToken) {
        return;
      }
      if (loadedTokenRef.current !== logToken) {
        loadedTokenRef.current = logToken;
        return;
      }
      reloadLogs();
      // `reloadLogs` changes identity on every sheet update, which would make
      // this effect a loop; the option list is what should trigger a re-read.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [logToken, logContainer, logSince, logTimestamps, logPrevious, prefs.logTail]);

    useEffect(() => {
      if (!logFollow || !logToken) {
        return undefined;
      }
      const timer = setInterval(() => reloadLogs(), LOG_POLL_MS);
      return () => clearInterval(timer);
    }, [logFollow, logToken, reloadLogs]);

    // --- text / table sheets ---------------------------------------------
    const openText = useCallback(
      async (title, subtitle, run, { language = "text" } = {}) => {
        const token = `${title}:${Date.now()}`;
        setSheet({ kind: "text", token, title, subtitle, text: "", pending: true, language });
        try {
          const result = await run();
          const body =
            typeof result === "string"
              ? result
              : String((result && (result.text ?? result.output)) || "");
          patchSheet("text", token, {
            text: body,
            pending: false,
            failure: result && result.ok === false ? result.failure : null,
          });
        } catch (error) {
          patchSheet("text", token, { text: errorText(error), pending: false });
        }
      },
      [patchSheet],
    );

    const openTable = useCallback(
      async (title, subtitle, run) => {
        const token = `${title}:${Date.now()}`;
        setSheet({ kind: "table", token, title, subtitle, columns: [], rows: [], pending: true });
        try {
          const result = await run();
          patchSheet("table", token, {
            columns: result.columns,
            rows: result.rows,
            pending: false,
            failure: result.ok ? null : result.failure,
          });
        } catch (error) {
          patchSheet("table", token, {
            pending: false,
            failure: { kind: "error", message: errorText(error) },
          });
        }
      },
      [patchSheet],
    );

    // --- exec -------------------------------------------------------------
    const openExec = useCallback(
      (pod, namespace) => {
        setExecState({
          pod,
          namespace: namespace || "",
          container: "",
          containers: [],
          line: "",
          shell: true,
          history: [],
          running: false,
        });
        setSheet({ kind: "exec", token: pod, title: pod });
        scopedClient(namespace)
          .containers(pod)
          .then((result) => {
            if (result.ok) {
              setExecState((current) =>
                current && current.pod === pod
                  ? { ...current, containers: result.containers }
                  : current,
              );
            }
          })
          .catch(() => {});
      },
      [scopedClient],
    );

    const patchExec = useCallback((patch) => {
      setExecState((current) => (current ? { ...current, ...patch } : current));
    }, []);

    const runExec = useCallback(async () => {
      let pending = null;
      setExecState((current) => {
        if (!current || current.running || !current.line.trim()) {
          return current;
        }
        pending = current;
        return { ...current, running: true };
      });
      if (!pending) {
        return;
      }
      const record = (entry) =>
        setExecState((current) =>
          current ? { ...current, running: false, history: [...current.history, entry] } : current,
        );
      try {
        const result = await scopedClient(pending.namespace).exec(pending.pod, pending.line, {
          shell: pending.shell,
          container: pending.container || undefined,
        });
        record({ line: pending.line, text: result.text, exitCode: result.exitCode });
      } catch (error) {
        record({ line: pending.line, text: errorText(error), exitCode: -1 });
      }
    }, [scopedClient]);

    return {
      sheet,
      closeSheet,
      modal,
      openModal: setModal,
      closeModal,
      confirm,
      askConfirm: setConfirm,
      closeConfirm,
      runConfirm,
      openLogs,
      reloadLogs,
      openText,
      openTable,
      logContainer,
      setLogContainer,
      logContainers,
      logSince,
      setLogSince,
      logTimestamps,
      setLogTimestamps,
      logPrevious,
      setLogPrevious,
      logFollow,
      setLogFollow,
      logFilter,
      setLogFilter,
      logWrap,
      setLogWrap,
      execState,
      openExec,
      patchExec,
      runExec,
    };
  };
}
