// Overlay state: the sheets (logs, inspect, text, history, exec), the modals,
// the confirmation request, and the Docker Hub search.
//
// Each opener sets `{ kind, … }` with `pending: true`, then patches the same
// sheet once its command returns — and only if the sheet is still the one that
// was opened, so a slow inspect cannot overwrite a log view the user opened
// afterwards.

const LOG_POLL_MS = 3000;
const errorText = (error) => String((error && error.message) || error);

export function createOverlayState(react) {
  const { useCallback, useEffect, useState } = react;

  return function useOverlays({ client, prefs, activeSessionId, say }) {
    const [sheet, setSheet] = useState(null);
    const [modal, setModal] = useState(null);
    const [confirm, setConfirm] = useState(null);

    // Log view options: per-visit, except the tail size, which lives in prefs.
    const [logTimestamps, setLogTimestamps] = useState(false);
    const [logSince, setLogSince] = useState("");
    const [logFollow, setLogFollow] = useState(false);
    const [logFilter, setLogFilter] = useState("");
    const [logWrap, setLogWrap] = useState(true);

    const [execState, setExecState] = useState(null);
    const [searchState, setSearchState] = useState({
      term: "",
      rows: [],
      pending: false,
      error: "",
    });

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

    // Leaving the session invalidates every overlay: its content came from a
    // host the panel is no longer looking at.
    useEffect(() => {
      setSheet(null);
      setModal(null);
      setConfirm(null);
      setLogFollow(false);
    }, [activeSessionId]);

    /** Patches the open sheet only when it is still the one `token` opened. */
    const patchSheet = useCallback((kind, token, patch) => {
      setSheet((current) =>
        current && current.kind === kind && current.token === token
          ? { ...current, ...patch }
          : current,
      );
    }, []);

    // --- logs -------------------------------------------------------------
    const readLogs = useCallback(
      (target) =>
        target.kind === "compose"
          ? client.composeLogs(
              {
                project: target.project,
                files: target.files,
                workingDir: target.workingDir,
                services: target.services,
              },
              { tail: prefs.logTail, timestamps: logTimestamps },
            )
          : client.logs(target.reference, {
              tail: prefs.logTail,
              timestamps: logTimestamps,
              since: logSince || undefined,
            }),
      [client, prefs.logTail, logTimestamps, logSince],
    );

    const openLogs = useCallback(
      async (target) => {
        const token = `${target.title}:${Date.now()}`;
        setLogFollow(false);
        setLogFilter("");
        setSheet({ kind: "logs", token, target, text: "", pending: true });
        try {
          const result = await readLogs(target);
          patchSheet("logs", token, { text: result.text, pending: false });
        } catch (error) {
          patchSheet("logs", token, { text: errorText(error), pending: false });
        }
      },
      [patchSheet, readLogs],
    );

    const reloadLogs = useCallback(async () => {
      if (!sheet || sheet.kind !== "logs") {
        return;
      }
      const { token, target } = sheet;
      try {
        const result = await readLogs(target);
        patchSheet("logs", token, { text: result.text, pending: false });
      } catch (error) {
        say("danger", errorText(error));
      }
    }, [patchSheet, readLogs, say, sheet]);

    // Log follow: one re-read every few seconds while the sheet is open. It
    // stops on close, on session change and on unmount.
    const logToken = sheet && sheet.kind === "logs" ? sheet.token : null;
    useEffect(() => {
      if (!logFollow || !logToken) {
        return undefined;
      }
      const timer = setInterval(() => reloadLogs(), LOG_POLL_MS);
      return () => clearInterval(timer);
    }, [logFollow, logToken, reloadLogs]);

    // --- text / inspect / history ----------------------------------------
    const openText = useCallback(
      async (title, subtitle, run) => {
        const token = `${title}:${Date.now()}`;
        setSheet({ kind: "text", token, title, subtitle, text: "", pending: true });
        try {
          const result = await run();
          const body = typeof result === "string" ? result : String((result && result.output) || "");
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

    const openInspect = useCallback(
      async (kind, reference, title) => {
        const inspectors = {
          container: client.inspectContainer,
          image: client.inspectImage,
          volume: client.inspectVolume,
          network: client.inspectNetwork,
        };
        const token = `${kind}:${reference}:${Date.now()}`;
        setSheet({ kind: "inspect", token, title, subtitle: reference, pending: true });
        try {
          const result = await (inspectors[kind] || inspectors.container)(reference);
          patchSheet("inspect", token, {
            pending: false,
            summary: result.summary || null,
            entry: result.entry || null,
            raw: result.raw || "",
            failure: result.ok ? null : result.failure,
          });
        } catch (error) {
          patchSheet("inspect", token, { pending: false, raw: errorText(error) });
        }
      },
      [client, patchSheet],
    );

    const openHistory = useCallback(
      async (image) => {
        const token = `${image.id}:${Date.now()}`;
        setSheet({ kind: "history", token, title: image.reference, rows: [], pending: true });
        try {
          const result = await client.imageHistory(image.dangling ? image.id : image.reference);
          patchSheet("history", token, {
            rows: result.rows,
            pending: false,
            failure: result.ok ? null : result.failure,
          });
        } catch (error) {
          patchSheet("history", token, {
            pending: false,
            failure: { kind: "error", message: errorText(error) },
          });
        }
      },
      [client, patchSheet],
    );

    // --- exec -------------------------------------------------------------
    const openExec = useCallback((container) => {
      setExecState({
        reference: container.id,
        name: container.name,
        line: "",
        shell: true,
        user: "",
        workdir: "",
        history: [],
        running: false,
      });
      setSheet({ kind: "exec", token: container.id, title: container.name });
    }, []);

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
        const result = await client.exec(pending.reference, pending.line, {
          shell: pending.shell,
          user: pending.user || undefined,
          workdir: pending.workdir || undefined,
        });
        record({ line: pending.line, text: result.text, exitCode: result.exitCode });
      } catch (error) {
        record({ line: pending.line, text: errorText(error), exitCode: -1 });
      }
    }, [client]);

    // --- Docker Hub search ------------------------------------------------
    const runSearch = useCallback(
      async (term) => {
        const text = String(term ?? "").trim();
        if (!text) {
          return;
        }
        setSearchState({ term: text, rows: [], pending: true, error: "" });
        try {
          const result = await client.search(text, { limit: 25 });
          setSearchState({
            term: text,
            rows: result.rows,
            pending: false,
            error: result.ok ? "" : errorText(result.failure && result.failure.detail),
          });
        } catch (error) {
          setSearchState({ term: text, rows: [], pending: false, error: errorText(error) });
        }
      },
      [client],
    );

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
      openInspect,
      openHistory,
      logTimestamps,
      setLogTimestamps,
      logSince,
      setLogSince,
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
      searchState,
      runSearch,
    };
  };
}
