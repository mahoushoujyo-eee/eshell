// External plugin loader (Route A: trusted local ESM in the host context).
//
// Lifecycle (see `docs/plans/external-plugin-contract.md`):
//
//   main.jsx, before the first React render:
//     registerBuiltinPlugins()
//     await loadExternalPlugins()
//     createRoot().render(<App />)
//
// `loadExternalPlugins()` subscribes to `extensions-changed` FIRST, then
// fetches both catalogs:
//   - `list_extensions`        the merged builtin + external catalog
//                              (the authoritative enabled state)
//   - `list_external_plugins`  external descriptors only (bundle URLs)
//
// The merged snapshot seeds `extensionState` (through
// `seedExtensionStateSnapshot`) so a persisted-disabled builtin or external
// never flashes enabled UI at startup.
//
// After the startup fetch, an `extensions-changed` event applies its payload
// as-is (it is the complete, authoritative descriptor list) and then re-reads
// `list_external_plugins` for DISCOVERY only. The split matters:
//   - flags always come from the event payload. Re-fetching `list_extensions`
//     here would let an out-of-order reply resurrect a plugin the event just
//     disabled.
//   - bundle URLs only exist in `list_external_plugins`, and an install or
//     uninstall changes which bundles exist, so discovery must be re-read or
//     a newly installed plugin could never load.
//
// Per enabled external descriptor: `import(/* @vite-ignore */ bundleUrl)` ->
// `activate(api)` (named or default export) under a generation token; the
// activation's staged panel/toolbar/controller registrations are validated
// against the whole registry (builtin sftp/status conflicts, reserved
// `draft`, other externals) and published atomically as one `registerPlugin`
// shape. Any failure — import error, activation throw, async timeout,
// conflict — discards the attempt (the API scope releases the staged
// registrations) and skips that plugin without blocking unrelated plugins or
// app startup.
//
// Disable: run the plugin's disposer, dispose the API scope (subscriptions a
// leaked plugin left behind), then unregister. Re-enable: activate again
// (the ESM module cache is expected; source changes need a restart). Rapid
// off/on and late completions serialize through a per-plugin generation: a
// completion arriving after a newer transition is discarded without rolling
// back the newer activation. Disabled plugins never execute plugin code.
import { createPluginHostBridge } from "../lib/plugin-host";
import { getPluginHostContext } from "./context";
import { seedExtensionStateSnapshot } from "./extensions/extensionState";
import { listPlugins, notifyPluginChanged, registerPlugin } from "./registry";
import { createPluginApi, disposeApiScope, PLUGIN_API_SCOPE } from "./api";

// The one bridge this module uses for native transport. `src/plugins`
// production code never imports `tauri-api` or `@tauri-apps/*` directly:
// `src/lib/plugin-host.js` is the only bridge, and the facade closes over
// the per-activation instance injected below.
const hostBridge = createPluginHostBridge();

// Async activation budget. Only asynchronous waiting is bounded: a plugin
// that loops synchronously can still freeze the app (explicitly trusted
// execution model; see the contract).
const ACTIVATION_TIMEOUT_MS = 10000;

// One external plugin's lifecycle state, keyed by extension id.
const externalPlugins = new Map();

const logPluginError = (extensionId, phase, error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[plugin ${extensionId}] ${phase} failed: ${message}`);
};

/** Resolves after `ms`, rejecting with a timeout label. */
const timeout = (ms) =>
  new Promise((_resolve, reject) => {
    setTimeout(() => reject(new Error(`activation timed out after ${ms}ms`)), ms);
  });

/**
 * Races one step against the activation budget. On timeout this rejects
 * with the budget label; the losing promise keeps running on its own (its
 * rejection is swallowed by the race, never unhandled).
 */
const withActivationTimeout = (promise, label) =>
  Promise.race([
    promise,
    timeout(ACTIVATION_TIMEOUT_MS).catch((error) => {
      error.message = `${label}: ${error.message}`;
      throw error;
    }),
  ]);

// ---------------------------------------------------------------------------
// Registration validation.
//
// The whole registry is visible here: builtin ids (`eshell.sftp`,
// `eshell.server-monitor`), every registered external, and the reserved
// `draft` key. A conflict skips the plugin (logged), never the app.
// ---------------------------------------------------------------------------
const RESERVED_KEYS = new Set(["draft"]);

const collectRegistryKeys = () => {
  const panelKeys = new Set(RESERVED_KEYS);
  const panelIds = new Set(RESERVED_KEYS);
  const toolbarIds = new Set(RESERVED_KEYS);
  const extensionIds = new Set();
  for (const plugin of listPlugins()) {
    extensionIds.add(plugin.id);
    const panels = typeof plugin.panels === "function" ? plugin.panels() : [];
    for (const panel of panels) {
      panelIds.add(panel.id);
      panelKeys.add(panel.key || panel.id);
    }
    const toolbar = typeof plugin.toolbar === "function" ? plugin.toolbar() : [];
    for (const item of toolbar) {
      toolbarIds.add(item.id);
    }
  }
  return { panelKeys, panelIds, toolbarIds, extensionIds };
};

const findContributionConflicts = (extensionId, panels, toolbar) => {
  const { panelKeys, panelIds, toolbarIds, extensionIds } = collectRegistryKeys();
  const conflicts = [];
  if (extensionIds.has(extensionId)) {
    conflicts.push(`extension id ${extensionId} is already registered`);
  }
  const seenPanelIds = new Set();
  const seenPanelKeys = new Set();
  for (const panel of panels) {
    if (seenPanelIds.has(panel.id)) {
      conflicts.push(`duplicate panel id ${panel.id}`);
    }
    seenPanelIds.add(panel.id);
    if (seenPanelKeys.has(panel.key)) {
      conflicts.push(`duplicate panel key ${panel.key}`);
    }
    seenPanelKeys.add(panel.key);
    if (panelIds.has(panel.id)) {
      conflicts.push(`panel id ${panel.id} conflicts with a registered plugin`);
    }
    if (panelKeys.has(panel.key)) {
      conflicts.push(`panel key ${panel.key} conflicts with a registered plugin`);
    }
  }
  const seenToolbarIds = new Set();
  for (const item of toolbar) {
    if (seenToolbarIds.has(item.id)) {
      conflicts.push(`duplicate toolbar id ${item.id}`);
    }
    seenToolbarIds.add(item.id);
    if (toolbarIds.has(item.id)) {
      conflicts.push(`toolbar id ${item.id} conflicts with a registered plugin`);
    }
  }
  return conflicts;
};

// ---------------------------------------------------------------------------
// Activation.
// ---------------------------------------------------------------------------
// The dynamic-import boundary. Production uses a runtime URL (Vite cannot
// statically analyze it; `@vite-ignore` keeps the build from failing). The
// indirection exists only so tests can substitute a controlled importer; it
// changes no loading semantics.
let importPluginBundle = (bundleUrl) => import(/* @vite-ignore */ bundleUrl);

/** Test-only: substitutes the dynamic-import boundary. */
export const setPluginBundleImporter = (importer) => {
  importPluginBundle = importer;
};

const resolveActivate = (module) => {
  if (module && typeof module.activate === "function") {
    return module.activate;
  }
  if (module && typeof module.default === "function") {
    return module.default;
  }
  return null;
};

/** Reads the private staged-contribution handle off one API object. */
const stagedHandle = (apiObject) => apiObject?.[PLUGIN_API_SCOPE] || null;

/**
 * Runs one activation attempt end to end. Resolves with the record fields on
 * success; rejects on any failure. On every failure path the attempt's own
 * API scope is disposed (releasing whatever the plugin managed to register
 * first), and the plugin's disposer — when the activation produced one
 * before failing, or produces one after a timeout — runs exactly once.
 *
 * The activation budget covers the *whole* attempt: the dynamic import
 * (which can be a never-settling TLA) and `activate`'s async wait both race
 * the timeout. A sync `activate` throw propagates directly.
 */
const runActivation = async ({ descriptor, bundleUrl, attempt }) => {
  const host = createPluginHostBridge();
  const apiObject = createPluginApi(descriptor.id, {
    host,
    getContext: () => getPluginHostContext(),
    // Contribution changes after publication re-resolve generic consumers:
    // the registry version bumps, `AppMainWorkspace`/`TopToolbar` re-render.
    // Before publication this fires into the void (only the loader is
    // watching), which is harmless.
    onContributionsChanged: () => notifyPluginChanged(),
  });
  // Per-activation bridge instance: each activation's API scope owns its own
  // subscriptions, so a re-activation cannot share a disposed scope.
  const handle = stagedHandle(apiObject);
  if (!handle) {
    disposeApiScope(apiObject);
    throw new Error("the API facade did not expose its staged handle");
  }
  // The scope is cancellable from the record: a concurrent disable disposes
  // it immediately (armed listeners release at once, not after the budget).
  attempt.apiObject = apiObject;

  // Exactly-once disposer bookkeeping. The activation promise keeps running
  // after a timeout: a disposer that resolves late is still the plugin's
  // cleanup for what it started, so it is captured and run exactly once —
  // by the publish path (teardown), a cancelled/discard path, or the
  // late-resolution path. deactivatePlugin calls `attempt.runDisposer`.
  let pluginDisposer = null;
  let disposerRan = false;
  const runDisposerOnce = (onAsyncError) => {
    if (disposerRan || typeof pluginDisposer !== "function") {
      return;
    }
    disposerRan = true;
    try {
      const result = pluginDisposer();
      if (result && typeof result.then === "function" && onAsyncError) {
        result.catch(onAsyncError);
      }
    } catch (error) {
      console.warn("[plugin-loader] plugin disposer threw", error);
    }
  };
  attempt.runDisposer = runDisposerOnce;

  // Tracks budget timers created below so every settled path clears them:
  // a fast enable/disable cycle must not accumulate 10s timers.
  const budgetTimers = [];
  const clearBudgetTimers = () => {
    while (budgetTimers.length > 0) {
      clearTimeout(budgetTimers.pop());
    }
  };
  /** A FULFILLED budget marker at ACTIVATION_TIMEOUT_MS (never a rejection,
   *  so the race cannot see a spurious timer error). */
  const budgetExpired = () =>
    new Promise((resolve) => {
      budgetTimers.push(
        setTimeout(() => resolve(Symbol("activation-timeout")), ACTIVATION_TIMEOUT_MS),
      );
    });

  let settled = false;

  const cleanupUnsettled = (reason) => {
    // Every non-publish exit disposes the attempt's scope: subscriptions the
    // plugin armed before failing release here, and the scope guard refuses
    // any it tries to add afterwards. A concurrent disable may already have
    // disposed it (attempt.cancelled): disposeApiScope is idempotent.
    if (reason === "cancelled") {
      // deactivatePlugin already disposed the scope and ran the disposer.
      return;
    }
    disposeApiScope(apiObject);
    runDisposerOnce((error) => {
      console.warn(`[plugin-loader] ${reason} disposer rejected`, error);
    });
  };

  try {
    // Import under the budget: a TLA that never settles must not hold the
    // loader hostage beyond the timeout.
    const module = await withActivationTimeout(
      importPluginBundle(bundleUrl),
      `import ${descriptor.id}`,
    );
    if (attempt.cancelled) {
      // Disabled while the import was in flight: `activate` never runs.
      // The scope and disposer were handled by deactivatePlugin.
      settled = true;
      return null;
    }
    const activate = resolveActivate(module);
    if (!activate) {
      throw new Error("the module exports neither activate nor default");
    }

    const activation = activate(apiObject);
    if (activation && typeof activation.then === "function") {
      // The activation promise is awaited under the same budget, but the
      // promise itself keeps running: a continuation attached here captures
      // a disposer that resolves after a timeout, so it still runs exactly
      // once (below). Nothing about a timeout unwinds the plugin's own work.
      const activationContinuation = activation.then(
        (awaited) => ({ ok: true, awaited }),
        (error) => ({ ok: false, error }),
      );
      const awaited = await Promise.race([activationContinuation, budgetExpired()]);
      clearBudgetTimers();
      if (attempt.cancelled) {
        settled = true;
        return null;
      }
      if (typeof awaited === "symbol") {
        // The activation is still running. Its late completion runs the
        // disposer exactly once, for the plugin's own cleanup; it cannot
        // resurrect anything (the scope guard refuses a disposed scope).
        void activationContinuation.then((result) => {
          if (!result.ok) {
            console.warn(
              `[plugin ${descriptor.id}] activation rejected after timeout`,
              result.error,
            );
            return;
          }
          pluginDisposer = typeof result.awaited === "function" ? result.awaited : null;
          runDisposerOnce((error) => {
            console.warn("[plugin-loader] late plugin disposer rejected", error);
          });
        });
        throw new Error(`activation timed out after ${ACTIVATION_TIMEOUT_MS}ms`);
      }
      if (!awaited.ok) {
        throw awaited.error;
      }
      pluginDisposer = typeof awaited.awaited === "function" ? awaited.awaited : null;
    } else {
      pluginDisposer = typeof activation === "function" ? activation : null;
    }
    if (attempt.cancelled) {
      settled = true;
      return null;
    }

    // Stage everything the plugin registered, then validate against the
    // whole registry before publishing: a conflicting contribution never
    // reaches `registerPlugin`. The published closures read the scope's
    // LIVE lists (not this validation snapshot), so a post-publish
    // register/unregister changes what consumers resolve — and fires
    // `onContributionsChanged`, which the loader points at the registry's
    // change notification.
    const panels = handle.listPanels();
    const toolbar = handle.listToolbar();
    const controller = handle.getController();
    const conflicts = findContributionConflicts(descriptor.id, panels, toolbar);
    if (conflicts.length > 0) {
      runDisposerOnce((error) => {
        console.warn("[plugin-loader] plugin disposer rejected", error);
      });
      throw new Error(`registration conflicts: ${conflicts.join("; ")}`);
    }

    settled = true;
    return {
      apiObject,
      // The publish path owns the disposer; it runs on teardown, once.
      runPluginDisposer: (onAsyncError) => runDisposerOnce(onAsyncError),
      listPanels: () => handle.listPanels(),
      listToolbar: () => handle.listToolbar(),
      getController: () => handle.getController(),
      controller,
    };
  } catch (error) {
    if (attempt.cancelled) {
      // deactivatePlugin handled the scope and the disposer; this throw is
      // the losing attempt's noise.
      settled = true;
      return null;
    }
    throw error;
  } finally {
    clearBudgetTimers();
    if (!settled) {
      cleanupUnsettled(attempt.cancelled ? "cancelled" : "failed");
    }
  }
};

/** Publishes one validated activation into the registry. */
const publishActivation = (record, activation) => {
  const unregister = registerPlugin({
    id: record.descriptor.id,
    builtin: false,
    api: activation.apiObject,
    // LIVE closures: post-publish register/unregister through the plugin's
    // API changes these results, and the API's `onContributionsChanged`
    // (wired to the registry's change notification below) makes consumers
    // re-resolve. The controller hook identity is fixed at publish: swapping
    // it would change hook order, which the contract forbids — a plugin
    // replacing its controller re-activates instead.
    createController: activation.controller || undefined,
    panels: () => activation.listPanels(),
    toolbar: () => activation.listToolbar(),
  });
  record.registered = unregister;
  record.apiObject = activation.apiObject;
  record.runPluginDisposer = activation.runPluginDisposer;
  return unregister;
};

/** Tears down one published activation: plugin disposer (exactly once, even
 *  if a re-activation already took over the record), API scope, registry. */
const teardownPublishedActivation = (record) => {
  const { apiObject, registered } = record;
  const runPluginDisposer = record.runPluginDisposer;
  record.runPluginDisposer = null;
  record.apiObject = null;
  record.registered = null;
  if (typeof runPluginDisposer === "function") {
    runPluginDisposer((error) => {
      console.warn("[plugin-loader] plugin disposer rejected", error);
    });
  }
  if (apiObject) {
    disposeApiScope(apiObject);
  }
  if (typeof registered === "function") {
    registered();
  }
};

// ---------------------------------------------------------------------------
// Catalog plumbing.
// ---------------------------------------------------------------------------
const normalizeExternalDescriptor = (row) => {
  if (!row || typeof row !== "object" || row.builtin !== false) {
    return null;
  }
  const id = String(row.id || "").trim();
  const bundleUrl = String(row.bundleUrl || "").trim();
  if (!id || !bundleUrl) {
    return null;
  }
  return {
    ...row,
    id,
    bundleUrl,
    enabled: row.enabled !== false,
    builtin: false,
  };
};

// ---------------------------------------------------------------------------
// Lifecycle transitions (generation-serialized).
// ---------------------------------------------------------------------------
/**
 * Runs one activation attempt for the record. The returned promise settles
 * when the attempt has fully resolved — published, discarded or failed —
 * so a caller that awaits it (the startup path) knows the registry is final.
 * It never rejects: failures are logged here.
 *
 * The attempt's cancellable resources (the API scope and its pending
 * subscriptions) live on the RECORD, not in this closure: a disable that
 * lands while the import or activate is still pending disposes the scope
 * immediately (releasing armed listeners now, not after the 10s budget) and
 * marks the attempt cancelled, so the import resolving later never calls
 * `activate` at all.
 */
const activatePlugin = async (record) => {
  const generation = ++record.generation;
  const descriptor = record.descriptor;
  record.activating = true;

  // The attempt's API scope, created eagerly so a concurrent disable can
  // dispose it mid-flight. `cancelled` is set by deactivatePlugin; the
  // checks below are the only places the attempt proceeds.
  const attempt = {
    cancelled: false,
    apiObject: null,
  };
  record.attempt = attempt;

  try {
    const activation = await runActivation({
      descriptor,
      bundleUrl: descriptor.bundleUrl,
      attempt,
    });
    if (!activation || attempt.cancelled || generation !== record.generation) {
      // A newer transition (a disable, or a re-enable superseding this
      // attempt) won: do not publish. runActivation already disposed the
      // scope and ran the disposer exactly once on its own cancelled path
      // (`null` return), or the supersede landed after it settled and its
      // settled cleanup already ran there.
      return;
    }
    publishActivation(record, activation);
  } catch (error) {
    if (attempt.cancelled || generation !== record.generation) {
      // A newer transition already tore this plugin down; the failure is
      // expected noise from the losing attempt, not a new problem.
      return;
    }
    logPluginError(descriptor.id, "activation", error);
  } finally {
    record.attempt = null;
    if (record.generation === generation && !attempt.cancelled) {
      record.activating = false;
    }
  }
};

const deactivatePlugin = (record) => {
  // Invalidate any in-flight activation attempt first: its generation check
  // then discards the late completion instead of publishing over the disable.
  record.generation += 1;
  record.activating = false;
  const attempt = record.attempt;
  if (attempt) {
    // A pending attempt (import or activate still in flight): cancel it now.
    // Its scope is disposed immediately — armed listeners release at once,
    // not after the 10s budget — and `activate` is never called when the
    // import resolves later. runActivation's own paths see attempt.cancelled
    // and skip their duplicated cleanup.
    attempt.cancelled = true;
    if (attempt.apiObject) {
      disposeApiScope(attempt.apiObject);
    }
    if (typeof attempt.runDisposer === "function") {
      attempt.runDisposer((error) => {
        console.warn("[plugin-loader] cancelled activation disposer rejected", error);
      });
    }
  }
  if (!record.registered && !record.apiObject) {
    // Nothing was published (an activation was still pending, or the plugin
    // never activated): the generation bump and the attempt cancellation
    // above were all that was needed.
    return;
  }
  teardownPublishedActivation(record);
};

// ---------------------------------------------------------------------------
// The extensions-changed subscription and catalog application.
// ---------------------------------------------------------------------------
let extensionsChangedUnlisten = null;

// Strict catalog revision: bumped on every applied catalog. A fetch reply
// that lands after a newer catalog was applied is dropped wholesale, so a
// delayed startup fetch can never re-enable a plugin an event disabled.
let catalogRevision = 0;

// Immutable-per-run external bundle discovery: id -> descriptor row from
// `list_external_plugins` (bundle URLs, `main`, display metadata; no
// enabled flag semantics — flags always come from the newest catalog).
// Stored the moment a fetch returns, BEFORE the revision check, so a stale
// fetch that is dropped as an application still contributes its discovery
// metadata: an enabled external can never be stranded unloadable because
// its only fetch lost a revision race.
const bundleDiscovery = new Map();

// The newest applied catalog (the authoritative enabled state). A stale
// fetch that is dropped re-applies THIS catalog against its own newly
// recorded discovery rows, so an external the stale fetch discovered is
// activated per the newest flags — never stranded until the next event.
let lastAppliedCatalog = null;

/**
 * Replaces the discovery cache with one reply's rows.
 *
 * REPLACE, not merge: the reply is the current truth about which bundles
 * exist on disk. Merging would let an uninstalled plugin linger, and
 * `applyCatalog` reads this cache to decide which externals exist.
 */
const replaceBundleDiscovery = (rows) => {
  bundleDiscovery.clear();
  for (const row of rows) {
    bundleDiscovery.set(row.id, { ...row });
  }
};

/** Re-reads bundle discovery alone, leaving the applied catalog's flags
 *  untouched. Used after install/uninstall, which change the bundle set but
 *  whose event payload carries no bundle URLs. */
const refreshBundleDiscovery = async () => {
  const externalCatalog = await hostBridge.listExternalPlugins();
  replaceBundleDiscovery(
    (externalCatalog || []).map(normalizeExternalDescriptor).filter(Boolean),
  );
};

// While `loadExternalPlugins` runs, EVERY activation attempt started while
// the startup queue is draining is recorded here — including ones an
// extensions-changed event fires mid-startup — so the startup path awaits
// them all: the registry is final (contributions resolvable) when
// `loadExternalPlugins` resolves. Cleared only after the queue drains.
let activationTracker = null;

const applyCatalog = (catalog) => {
  catalogRevision += 1;
  lastAppliedCatalog = catalog;
  // Seed the authoritative enabled state first: a persisted-disabled row
  // (builtin or external) must not flash enabled UI. The seed is a
  // replayable snapshot (latest wins), not consume-once.
  seedExtensionStateSnapshot(catalog);

  // The enabled flags come from the newest catalog alone (the event payload
  // IS the complete authoritative descriptor list). Bundle discovery rows
  // are stored separately (immutable per run, see refreshExternalPluginCatalog
  // and bundleDiscovery) so a stale fetch being dropped can never strand an
  // enabled external: the discovery metadata survives for the next catalog.
  const catalogById = new Map(
    (catalog || []).map((entry) => [String(entry?.id ?? ""), entry]),
  );
  // Externals come from the catalog, which is authoritative for which
  // bundles EXIST and whether they are enabled; discovery only supplies the
  // bundle URL. A discovery row whose id is absent from the catalog is a
  // plugin that no longer exists — removed by Settings → Plugins → Remove —
  // and must not be resurrected out of this cache.
  const externalRows = [...bundleDiscovery.values()]
    .filter((row) => catalogById.has(row.id))
    .map((row) => ({ ...row, enabled: catalogById.get(row.id).enabled !== false }));
  const knownIds = new Set(externalPlugins.keys());
  for (const row of externalRows) {
    knownIds.delete(row.id);
    const enabled = row.enabled !== false;
    let record = externalPlugins.get(row.id);
    if (!record) {
      record = {
        descriptor: { ...row, enabled },
        generation: 0,
        activating: false,
        registered: null,
        apiObject: null,
        runPluginDisposer: null,
        attempt: null,
      };
      externalPlugins.set(row.id, record);
    } else {
      record.descriptor = { ...row, enabled };
    }
    const registered = Boolean(record.registered);
    if (enabled && !registered) {
      if (!record.activating) {
        const attempt = activatePlugin(record);
        if (activationTracker) {
          activationTracker(attempt);
        } else {
          void attempt;
        }
      }
      // An activation attempt already in flight for this record: its own
      // generation guard decides whether it may publish.
    } else if (!enabled) {
      // A disable invalidates any in-flight activation attempt (its scope
      // and armed listeners release immediately; a pending import never
      // calls activate) and tears down a published registration. A record
      // that was never activated and is not activating stays untouched:
      // disabled plugins never execute.
      if (registered || record.activating) {
        deactivatePlugin(record);
      }
    }
    // enabled && registered: nothing to do.
  }
  // Externals that vanished from the catalog entirely (the directory was
  // removed by Settings → Plugins → Remove): retire them, tearing down a
  // published activation so the toolbar button and panel go with it.
  //
  // This used to run on the startup path only, on the assumption that
  // removal required a restart. Removal is a runtime operation now, so an
  // event application must retire too — otherwise the removed plugin's
  // contributions stay on screen with no way to get rid of them.
  for (const id of knownIds) {
    const record = externalPlugins.get(id);
    if (!record) {
      continue;
    }
    if (record.registered || record.activating) {
      deactivatePlugin(record);
    }
    externalPlugins.delete(id);
  }
};

const handleExtensionsChanged = (event) => {
  // The event payload IS the complete authoritative descriptor list (the
  // backend emits it from the same serialized lifecycle transaction that
  // persisted the change): flags come straight from it, with no re-fetch —
  // a re-fetch could land out of order and resurrect a disabled plugin.
  const payload = Array.isArray(event?.payload) ? event.payload : null;
  if (!payload) {
    return;
  }
  // Apply first: an uninstall retires its plugin here, immediately, so the
  // removed contributions are gone before the round trip below.
  applyCatalog(payload);

  // An install or uninstall changes which bundles exist on disk, and the
  // payload carries only descriptors — no bundle URLs — so discovery has to
  // be re-read: without it a newly installed plugin could never load, and a
  // removed one would linger in the cache. This used to be startup-only,
  // when nothing but a restart could change the bundle set.
  //
  // Only DISCOVERY is re-read. The flags stay whatever this event said:
  // re-applying a re-fetched `list_extensions` here is exactly the
  // out-of-order resurrection the no-re-fetch rule above forbids.
  const appliedAt = catalogRevision;
  void refreshBundleDiscovery()
    .then(() => {
      // A newer event applied its own payload while discovery was in
      // flight; re-applying this older one would resurrect its flags.
      if (appliedAt !== catalogRevision) {
        return;
      }
      // Re-apply the SAME payload, now that discovery knows the new bundle:
      // a freshly installed plugin activates on this pass.
      applyCatalog(payload);
    })
    .catch((error) => {
      logPluginError("extensions", "bundle discovery refresh", error);
    });
};

// ---------------------------------------------------------------------------
// Public surface.
// ---------------------------------------------------------------------------
// The in-flight startup promise: concurrent loadExternalPlugins callers all
// await the SAME run (the second caller must not see a resolved-but-empty
// result because the first caller's activations are still pending).
let startupPromise = null;

/**
 * Fetches both catalogs and applies them. The startup path; a strict
 * revision discards a reply that lands after a newer catalog was applied,
 * so a delayed startup fetch can never re-enable a plugin an event
 * disabled. The discovery rows are recorded BEFORE the revision check: a
 * dropped stale application still contributes its immutable bundle
 * metadata, so an enabled external is never stranded unloadable.
 */
export const refreshExternalPluginCatalog = async () => {
  const revision = ++catalogRevision;
  const [catalog, externalCatalog] = await Promise.all([
    hostBridge.listExtensions(),
    hostBridge.listExternalPlugins(),
  ]);
  const rows = (externalCatalog || []).map(normalizeExternalDescriptor).filter(Boolean);
  if (revision !== catalogRevision) {
    // A newer catalog (an extensions-changed event) was applied while this
    // fetch was in flight: drop the stale application — but re-apply the
    // NEWEST catalog against this fetch's discovery rows, so an external
    // only this fetch discovered is activated per the newest flags instead
    // of waiting for the next event (which may never come).
    //
    // Merge rather than replace here: this reply predates the event, so it
    // may not know about a bundle the event's own refresh already found.
    for (const row of rows) {
      bundleDiscovery.set(row.id, { ...row });
    }
    if (lastAppliedCatalog) {
      applyCatalog(lastAppliedCatalog);
    }
    return;
  }
  replaceBundleDiscovery(rows);
  applyCatalog(catalog);
};

/**
 * Subscribes to lifecycle changes and loads every enabled external plugin.
 *
 * Must complete before the first React render (contribution resolution is
 * synchronous) — including every activation attempt started while the
 * startup queue drains (its own, and any an extensions-changed event fires
 * mid-startup): the returned promise settles only after all of them have
 * resolved (published, discarded or failed), so `main.jsx`'s `.then(render)`
 * cannot render early. Concurrent callers await the SAME in-flight run.
 * Never throws: a failing plugin is skipped and logged, and a failing
 * catalog fetch leaves the app on the builtin manifest.
 */
export function loadExternalPlugins() {
  if (startupPromise) {
    // A second caller while the first run is still draining awaits the same
    // promise: it must not observe "done" before the first run's
    // activations have settled.
    return startupPromise;
  }
  startupPromise = (async () => {
    // Subscribe FIRST: a transition that fires while the catalogs are being
    // fetched is not missed. The event applies its own payload directly; the
    // startup fetch's revision guard drops its stale application (keeping
    // its discovery rows) in that case.
    try {
      if (typeof extensionsChangedUnlisten === "function") {
        extensionsChangedUnlisten();
      }
      extensionsChangedUnlisten = await hostBridge.listenPluginEvent(
        "extensions-changed",
        handleExtensionsChanged,
      );
    } catch (error) {
      console.warn("[plugin-loader] extensions-changed subscription failed", error);
    }

    // Every activation attempt started while this run drains, awaited: the
    // registry is final when this promise resolves. The tracker stays
    // installed until the queue has drained — including attempts an event
    // fires mid-startup — and is only then cleared.
    const pendingActivations = [];
    activationTracker = (attempt) => pendingActivations.push(attempt);
    try {
      await refreshExternalPluginCatalog();
    } catch (error) {
      console.warn(
        "[plugin-loader] external plugin discovery failed; continuing on builtins",
        error,
      );
    } finally {
      // Drain the queue BEFORE clearing the tracker: an attempt an event
      // started during the drain is in pendingActivations; one started
      // after this line runs untracked (post-startup, nothing awaits it).
      await Promise.all(pendingActivations.map((attempt) => attempt.catch(() => {})));
      activationTracker = null;
    }
  })();
  // A failed startup never poisons later callers: the next call re-runs.
  const settled = startupPromise.then(
    () => {
      startupPromise = null;
    },
    () => {
      startupPromise = null;
    },
  );
  void settled;
  return startupPromise;
}

/**
 * The external descriptors this loader knows about, for the extension
 * management UI. Not the enabled state: `extensionState` stays authoritative.
 */
export const listExternalPluginDescriptors = () =>
  [...externalPlugins.values()].map((record) => ({ ...record.descriptor }));

/**
 * Test/teardown hook: releases the extensions-changed subscription and
 * deactivates every registered external plugin. The app never calls this.
 */
export const unloadExternalPlugins = () => {
  if (typeof extensionsChangedUnlisten === "function") {
    extensionsChangedUnlisten();
    extensionsChangedUnlisten = null;
  }
  for (const record of [...externalPlugins.values()]) {
    deactivatePlugin(record);
  }
  externalPlugins.clear();
  bundleDiscovery.clear();
  catalogRevision = 0;
  activationTracker = null;
  startupPromise = null;
};
