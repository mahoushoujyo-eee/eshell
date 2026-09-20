// The panel's controller: one per activation (`ui.registerController`), shared
// by the panel, which is a pure render of the snapshot returned here.
//
// Composition:
//   prefs.js      persisted choices — CLI prefix, context, namespace, kind
//   listings.js   the resource table plus the cluster metadata
//   derive.js     pure column/row shaping and the health summary
//   overlays.js   sheets, modals, the confirm request, exec
//
// This file adds what needs all of the above: the client (scoped to the selected
// context and namespace), the notice bar, `task`/`bulkTask`, and selection.

import { createKubectlClient } from "../client.js";
import { describeFailure } from "../failures.js";
import { resolveKind } from "../kinds.js";
import { filterRows, isUnhealthy, summarise, visibleColumns } from "./derive.js";
import { createListings } from "./listings.js";
import { createOverlayState } from "./overlays.js";
import { createPrefs } from "./prefs.js";

export { AUTO_REFRESH_OPTIONS, LOG_TAIL_OPTIONS, SINCE_OPTIONS } from "./prefs.js";

const failureText = (failure) => describeFailure(failure).text;
const errorText = (error) => String((error && error.message) || error);

export function createKubectlController(react, { useLocale } = {}) {
  const { useCallback, useEffect, useMemo, useState } = react;
  const usePrefs = createPrefs(react);
  const useListings = createListings(react);
  const useOverlays = createOverlayState(react);

  return function useKubectlController({ api, activeSessionId, activeSession }) {
    // Observing the host's language here (not in the panel) means one
    // subscription for the whole plugin: the controller publishes a new
    // snapshot, which is what re-renders the panel.
    const locale = useLocale ? useLocale() : "en";
    const prefs = usePrefs(api.storage);
    const hasSession = Boolean(activeSessionId);

    const [customKind, setCustomKind] = useState("");
    const [query, setQuery] = useState("");
    const [onlyProblems, setOnlyProblems] = useState(false);
    const [selection, setSelection] = useState(() => new Set());
    const [notice, setNotice] = useState(null);
    const [busy, setBusy] = useState(() => new Set());

    // The active resource type: a tab key, or whatever was typed into the
    // "other type" box — `kubectl get <anything>` has to keep working.
    const descriptor = useMemo(
      () => resolveKind(customKind.trim() || prefs.kindKey),
      [customKind, prefs.kindKey],
    );

    // One client per (session, prefix, context, namespace scope). Every command
    // carries `--context` / `-n`, so nothing on the host is mutated to change
    // what the panel is looking at.
    const client = useMemo(
      () =>
        createKubectlClient(
          (command) =>
            activeSessionId
              ? api.sessions.execute(activeSessionId, command)
              : Promise.reject(new Error("no active session")),
          {
            bin: prefs.bin,
            context: prefs.context,
            namespace: prefs.namespace,
            allNamespaces: prefs.allNamespaces,
          },
        ),
      [api, activeSessionId, prefs.bin, prefs.context, prefs.namespace, prefs.allNamespaces],
    );

    /**
     * The client to use for one row's commands. In `--all-namespaces` the rows
     * come from many namespaces, so a command against one of them has to name
     * the namespace that row reported rather than the panel's selection.
     */
    const clientFor = useCallback(
      (row) =>
        row && row.namespace
          ? client.withScope({ namespace: row.namespace, allNamespaces: false })
          : client,
      [client],
    );

    const scopeKey = `${activeSessionId || ""}|${prefs.bin}|${prefs.context}`;
    const say = useCallback((tone, text, extra = {}) => setNotice({ tone, text, ...extra }), []);
    const overlays = useOverlays({ client, prefs, scopeKey, say });

    const listings = useListings({
      client,
      activeSessionId,
      descriptor,
      scopeKey,
      sortByAge: prefs.sortByAge,
      autoRefresh: prefs.autoRefresh,
      // A dialog is a decision the user is in the middle of; re-reading under it
      // would move the rows behind the dialog.
      paused: Boolean(overlays.sheet || overlays.modal || overlays.confirm),
    });

    // Selection and the filter are per listing: keeping them across a kind,
    // namespace or session switch would let a bulk delete hit rows the user
    // cannot see.
    useEffect(() => {
      setSelection(new Set());
      setQuery("");
    }, [descriptor.key, prefs.namespace, prefs.allNamespaces, scopeKey]);

    const markBusy = useCallback((key, on) => {
      setBusy((current) => {
        const next = new Set(current);
        if (on) {
          next.add(key);
        } else {
          next.delete(key);
        }
        return next;
      });
    }, []);

    const task = useCallback(
      async (key, label, run, { reload = true } = {}) => {
        markBusy(key, true);
        say("info", `${label}…`, { busy: true });
        try {
          const result = await run();
          if (result && result.ok === false) {
            say("danger", `${label}: ${failureText(result.failure)}`, { command: result.command });
            return result;
          }
          const output = String((result && (result.output ?? result.text)) || "").trim();
          const tail = output.split("\n").filter(Boolean).pop();
          say("success", tail ? `${label} — ${tail}` : label);
          return result;
        } catch (error) {
          say("danger", `${label}: ${errorText(error)}`);
          return { ok: false };
        } finally {
          markBusy(key, false);
          if (reload) {
            await listings.load({ quiet: true });
          }
        }
      },
      [listings, markBusy, say],
    );

    /**
     * Runs the same call over every selected row, one after another rather than
     * in parallel: the API server serialises these anyway, and a failed item
     * should not be lost in a burst of notices.
     */
    const bulkTask = useCallback(
      async (label, targets, run) => {
        const list = [...targets];
        if (list.length === 0) {
          return;
        }
        markBusy("bulk", true);
        let done = 0;
        let firstFailure = null;
        for (const target of list) {
          say("info", `${label} ${done + 1}/${list.length}…`, { busy: true });
          try {
            const result = await run(target);
            if (result && result.ok === false) {
              firstFailure = firstFailure || result.failure;
            } else {
              done += 1;
            }
          } catch (error) {
            firstFailure = firstFailure || { kind: "error", message: errorText(error) };
          }
        }
        markBusy("bulk", false);
        say(
          firstFailure ? "danger" : "success",
          firstFailure
            ? `${label}: ${done}/${list.length} — ${failureText(firstFailure)}`
            : `${label} ${done}/${list.length}`,
        );
        setSelection(new Set());
        await listings.load({ quiet: true });
      },
      [listings, markBusy, say],
    );

    // --- derived views ----------------------------------------------------
    const columns = useMemo(
      () => visibleColumns(listings.columns, { hideNoisy: prefs.hideNoisy }),
      [listings.columns, prefs.hideNoisy],
    );
    const rows = useMemo(() => {
      const matched = filterRows(listings.rows, query);
      return onlyProblems ? matched.filter(isUnhealthy) : matched;
    }, [listings.rows, onlyProblems, query]);
    const summary = useMemo(() => summarise(listings.rows), [listings.rows]);

    const selectedRows = useMemo(
      () => rows.filter((row) => selection.has(row.key)),
      [rows, selection],
    );

    const toggleSelect = useCallback((key) => {
      setSelection((current) => {
        const next = new Set(current);
        if (next.has(key)) {
          next.delete(key);
        } else {
          next.add(key);
        }
        return next;
      });
    }, []);
    const toggleSelectAll = useCallback(
      (on, keys) => setSelection(on ? new Set(keys) : new Set()),
      [],
    );
    const clearSelection = useCallback(() => setSelection(new Set()), []);
    const dismissNotice = useCallback(() => setNotice(null), []);
    const isBusy = useCallback((key) => busy.has(key), [busy]);

    return {
      ...prefs,
      ...overlays,
      locale,
      hasSession,
      hostLabel: (activeSession && activeSession.configName) || activeSessionId || "",
      scopeKey,

      descriptor,
      customKind,
      setCustomKind,
      columns,
      rows,
      allRows: listings.rows,
      summary,
      note: listings.note,
      loading: listings.loading,
      failure: listings.failure,
      contexts: listings.contexts,
      currentContext: listings.currentContext,
      namespaces: listings.namespaces,
      version: listings.version,
      refresh: listings.refresh,

      query,
      setQuery,
      onlyProblems,
      setOnlyProblems,
      selection,
      selectedRows,
      toggleSelect,
      toggleSelectAll,
      clearSelection,

      notice,
      dismissNotice,
      say,
      isBusy,
      anyBusy: busy.size > 0,

      client,
      clientFor,
      task,
      bulkTask,
    };
  };
}
