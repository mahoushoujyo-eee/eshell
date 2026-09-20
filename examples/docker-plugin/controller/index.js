// The panel's controller: one per activation (`ui.registerController`), shared
// by the panel, which is a pure render of the snapshot returned here.
//
// Composition:
//   prefs.js      persisted choices and the CLI prefix
//   listings.js   what each tab shows, and when it is re-read
//   derive.js     pure filtering / grouping / counting
//   overlays.js   sheets, modals, the confirm request, exec, Hub search
//
// This file adds the parts that need all of the above: the client, the notice
// bar, `task`/`bulkTask` (run one command, report it, re-read the tab) and row
// selection.

import { createDockerClient } from "../client.js";
import { describeDockerFailure } from "../failures.js";
import {
  countAll,
  filterContainers,
  filterEvents,
  filterImages,
  filterNetworks,
  filterVolumes,
  groupComposeProjects,
  indexStats,
} from "./derive.js";
import { createListings } from "./listings.js";
import { createOverlayState } from "./overlays.js";
import { createPrefs } from "./prefs.js";

export { AUTO_REFRESH_OPTIONS, EVENT_WINDOWS, LOG_TAIL_OPTIONS, TABS } from "./prefs.js";

const failureText = (failure) => describeDockerFailure(failure).text;
const errorText = (error) => String((error && error.message) || error);

export function createDockerController(react, { useLocale } = {}) {
  const { useCallback, useEffect, useMemo, useState } = react;
  const usePrefs = createPrefs(react);
  const useListings = createListings(react);
  const useOverlays = createOverlayState(react);

  return function useDockerController({ api, activeSessionId, activeSession }) {
    // Observing the host's language here (not in the panel) means one
    // subscription for the whole plugin: the controller publishes a new
    // snapshot, which is what re-renders the panel.
    const locale = useLocale ? useLocale() : "en";
    const prefs = usePrefs(api.storage);
    const hasSession = Boolean(activeSessionId);

    // One client per (session, prefix). `sessions.execute` is bound to the
    // session the panel is showing, so a superseded client can never write to
    // a session the user has already left.
    const client = useMemo(
      () =>
        createDockerClient(
          (command) =>
            activeSessionId
              ? api.sessions.execute(activeSessionId, command)
              : Promise.reject(new Error("no active session")),
          { bin: prefs.bin },
        ),
      [api, activeSessionId, prefs.bin],
    );

    const [notice, setNotice] = useState(null);
    const [busy, setBusy] = useState(() => new Set());
    const [query, setQuery] = useState("");
    const [stateFilter, setStateFilter] = useState("all");
    const [selection, setSelection] = useState(() => new Set());

    const say = useCallback((tone, text, extra = {}) => setNotice({ tone, text, ...extra }), []);

    const overlays = useOverlays({ client, prefs, activeSessionId, say });

    const listings = useListings({
      client,
      activeSessionId,
      tab: prefs.tab,
      imagesAll: prefs.imagesAll,
      imagesDangling: prefs.imagesDangling,
      eventWindow: prefs.eventWindow,
      statsEnabled: prefs.statsEnabled,
      autoRefresh: prefs.autoRefresh,
      // A dialog is a decision the user is in the middle of; re-reading under
      // it would move the rows behind the dialog.
      paused: Boolean(overlays.sheet || overlays.modal || overlays.confirm),
    });

    // Selection and the filter are per listing: keeping them across a tab or
    // session switch would let a bulk action hit rows the user cannot see.
    useEffect(() => {
      setSelection(new Set());
      setQuery("");
    }, [prefs.tab, activeSessionId]);

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

    /**
     * Runs one mutating client call: marks the row busy, reports the outcome in
     * the notice bar, and re-reads the listing. `label` is what the user sees.
     */
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
          const output = String((result && result.output) || "").trim();
          const tail = output.split("\n").filter(Boolean).pop();
          say("success", tail ? `${label} — ${tail}` : label);
          return result;
        } catch (error) {
          say("danger", `${label}: ${errorText(error)}`);
          return { ok: false };
        } finally {
          markBusy(key, false);
          if (reload) {
            await listings.loadTab(prefs.tab, { quiet: true });
          }
        }
      },
      [listings, markBusy, prefs.tab, say],
    );

    /**
     * Runs the same call over every selected row, one after another rather than
     * in parallel: docker serialises these anyway, and a failed item should not
     * be lost in a burst of notices.
     */
    const bulkTask = useCallback(
      async (label, keys, run) => {
        const targets = [...keys];
        if (targets.length === 0) {
          return;
        }
        markBusy("bulk", true);
        let done = 0;
        let firstFailure = null;
        for (const target of targets) {
          say("info", `${label} ${done + 1}/${targets.length}…`, { busy: true });
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
            ? `${label}: ${done}/${targets.length} — ${failureText(firstFailure)}`
            : `${label} ${done}/${targets.length}`,
        );
        setSelection(new Set());
        await listings.loadTab(prefs.tab, { quiet: true });
      },
      [listings, markBusy, prefs.tab, say],
    );

    // --- derived views ----------------------------------------------------
    const statsById = useMemo(() => indexStats(listings.stats), [listings.stats]);
    const containers = useMemo(
      () => filterContainers(listings.containers, { stateFilter, query, statsById }),
      [listings.containers, query, stateFilter, statsById],
    );
    const images = useMemo(() => filterImages(listings.images, query), [listings.images, query]);
    const volumes = useMemo(() => filterVolumes(listings.volumes, query), [listings.volumes, query]);
    const networks = useMemo(
      () => filterNetworks(listings.networks, query),
      [listings.networks, query],
    );
    const events = useMemo(() => filterEvents(listings.events, query), [listings.events, query]);
    const projects = useMemo(
      () =>
        groupComposeProjects({
          containers: listings.containers,
          composeProjects: listings.composeProjects,
          query,
          statsById,
        }),
      [listings.composeProjects, listings.containers, query, statsById],
    );

    const counts = useMemo(
      () => countAll({ containers, images, volumes, networks, projects, events }),
      [containers, events, images, networks, projects, volumes],
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

      loading: listings.loading,
      failure: listings.failure,
      composeFailure: listings.composeFailure,
      diskRows: listings.diskRows,
      info: listings.info,
      version: listings.version,
      refresh: listings.refresh,

      containers,
      allContainers: listings.containers,
      images,
      volumes,
      networks,
      events,
      projects,
      counts,

      query,
      setQuery,
      stateFilter,
      setStateFilter,
      selection,
      toggleSelect,
      toggleSelectAll,
      clearSelection,

      notice,
      dismissNotice,
      say,
      isBusy,
      anyBusy: busy.size > 0,

      client,
      task,
      bulkTask,
    };
  };
}
