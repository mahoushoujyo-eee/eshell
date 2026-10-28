// The panel's controller: one per activation (`ui.registerController`), shared
// by the panel, which is a pure render of the snapshot returned here.
//
// Composition:
//   prefs.js     persisted choices — binary, config path, service, privilege
//   derive.js    pure derivations over the config and the subscriptions
//   overlays.js  the open modal and the pending confirmation
//
// This file adds what needs all of the above: the client, the detection, the
// write path, and the actions for the three things the panel exists to do —
// add a group, update a subscription, select a node.

import { createXrayClient } from "../client.js";
import { describeFailure } from "../failures.js";
import {
  inboundPorts,
  nodeEndpoint,
  nodeTag,
  removeGroup,
  replaceNodes,
  setGroupSelector,
  summarize,
  upsertGroup,
} from "../parse/config.js";
import { parseObservatoryLog } from "../parse/observatory.js";
import { parseSubscription } from "../parse/subscription.js";
import { enrichGroups, enrichSubscriptions, groupNodes, matchNodes, mergeDelays, nodeNames } from "./derive.js";
import { createOverlayState } from "./overlays.js";
import { createPrefs } from "./prefs.js";

const failureText = (failure) => describeFailure(failure).text;
const errorText = (error) => String((error && error.message) || error);

const readList = (storage, key) => {
  const value = storage.get(key);
  return Array.isArray(value) ? value : [];
};

const readObject = (storage, key) => {
  const value = storage.get(key);
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
};

/** A tag prefix from a name: ASCII letters and digits, nothing else. */
export function slugify(value) {
  const slug = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || "sub";
}

/** An id for a stored record. */
const newId = () => `sub-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;

export function createXrayController(react, { useLocale, t } = {}) {
  const { useCallback, useEffect, useMemo, useRef, useState } = react;
  const usePrefs = createPrefs(react);
  const useOverlayState = createOverlayState(react);
  const translate = t || ((key) => key);

  return function useXrayController({ api, activeSessionId, activeSession }) {
    const locale = useLocale ? useLocale() : "en";
    const prefs = usePrefs(api.storage);
    const overlays = useOverlayState();
    const hasSession = Boolean(activeSessionId);

    const [info, setInfo] = useState(null);
    const [version, setVersion] = useState("");
    const [service, setService] = useState(null);
    const [config, setConfig] = useState(null);
    const [failure, setFailure] = useState(null);
    const [loading, setLoading] = useState(false);
    const [notice, setNotice] = useState(null);
    const [busy, setBusy] = useState(() => new Set());
    const [tab, setTab] = useState("groups");
    const [query, setQuery] = useState("");
    const [selectedGroup, setSelectedGroup] = useState("");
    const [subscriptions, setSubscriptions] = useState(() => readList(api.storage, "subscriptions"));
    const [groupState, setGroupState] = useState(() => readObject(api.storage, "groupState"));
    const [delays, setDelays] = useState({});

    const requestRef = useRef(0);

    // The plugin facade has no HTTP client and no local process, so every
    // command runs on the host the session is connected to.
    const client = useMemo(
      () =>
        createXrayClient((command) =>
          activeSessionId
            ? api.sessions.execute(activeSessionId, command)
            : Promise.reject(new Error("no active session")),
        ),
      [api, activeSessionId],
    );

    const say = useCallback((tone, text, extra = {}) => setNotice({ tone, text, ...extra }), []);

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

    const isBusy = useCallback((key) => busy.has(key), [busy]);

    // --- detection --------------------------------------------------------

    /**
     * Reads the host: what is installed, what is running, what the config
     * says. The overrides win over the detected values, so a host that the
     * probe reads wrong can still be driven by hand.
     */
    const load = useCallback(
      async ({ quiet = false } = {}) => {
        if (!hasSession) {
          setInfo(null);
          setVersion("");
          setService(null);
          setConfig(null);
          setFailure(null);
          setDelays({});
          return;
        }
        const token = ++requestRef.current;
        const fresh = () => token === requestRef.current;
        if (!quiet) {
          setLoading(true);
        }
        try {
          const detected = await client.detect();
          if (!fresh()) return;
          if (!detected.ok) {
            setInfo(null);
            setFailure(detected.failure);
            return;
          }
          const found = detected.info;
          setInfo(found);

          const bin = prefs.bin || found.bin || "";
          const configPath = prefs.configPath || found.config || "";
          const unit = prefs.unit || found.unit || "";

          if (!configPath) {
            setConfig(null);
            setFailure({
              kind: "noConfig",
              detail: "no xray config file was found on this host",
            });
            return;
          }

          const [configResult, versionResult, serviceResult] = await Promise.all([
            client.readConfig(configPath),
            bin ? client.version(bin) : Promise.resolve({ ok: false, version: "" }),
            unit
              ? client.serviceState(unit)
              : Promise.resolve({ ok: true, active: "unknown", enabled: "unknown" }),
          ]);
          if (!fresh()) return;

          setConfig(configResult.ok ? configResult.config : null);
          setFailure(configResult.ok ? null : configResult.failure);
          setVersion(versionResult.version || "");
          setService(serviceResult);

          // The observatory writes its delay measurements into the log, so
          // the log is where the panel reads them from.
          const logPath = configResult.ok ? summarize(configResult.config).logPath : "";
          if (logPath) {
            const log = await client.readLog(logPath, 300);
            if (fresh()) {
              setDelays((current) => mergeDelays(parseObservatoryLog(log.text), current));
            }
          }
        } catch (error) {
          if (fresh()) {
            setFailure({ kind: "error", message: errorText(error) });
          }
        } finally {
          if (fresh()) {
            setLoading(false);
          }
        }
      },
      [client, hasSession, prefs.bin, prefs.configPath, prefs.unit],
    );

    useEffect(() => {
      load();
    }, [load]);

    // --- derived ----------------------------------------------------------

    const effective = useMemo(
      () => ({
        bin: prefs.bin || (info && info.bin) || "",
        configPath: prefs.configPath || (info && info.config) || "",
        unit: prefs.unit || (info && info.unit) || "",
        privilege: prefs.privilege,
        systemctl: info ? info.systemctl : true,
        writable: info ? info.writable : false,
        readable: info ? info.readable : false,
        dir: info ? info.dir : "",
        dirWritable: info ? info.dirWritable : false,
        sudo: info ? info.sudo : false,
        fetchTool: (info && info.fetch) || "curl",
      }),
      [prefs.bin, prefs.configPath, prefs.unit, prefs.privilege, info],
    );

    const groups = useMemo(() => enrichGroups(config, groupState), [config, groupState]);
    const names = useMemo(() => nodeNames(subscriptions), [subscriptions]);
    const subscriptionRows = useMemo(
      () => enrichSubscriptions(subscriptions, config),
      [subscriptions, config],
    );
    const summary = useMemo(() => summarize(config), [config]);
    const activeGroup = useMemo(
      () => groups.find((group) => group.tag === selectedGroup) || groups[0] || null,
      [groups, selectedGroup],
    );
    const activeNodes = useMemo(
      () => matchNodes(groupNodes(config, activeGroup, names), query),
      [config, activeGroup, names, query],
    );
    const activeDelays = useMemo(
      () => mergeDelays({}, delays),
      [delays],
    );

    // --- persistence ------------------------------------------------------

    useEffect(() => {
      api.storage.set("subscriptions", subscriptions);
    }, [api, subscriptions]);
    useEffect(() => {
      api.storage.set("groupState", groupState);
    }, [api, groupState]);

    // --- writing ----------------------------------------------------------

    /**
     * The one path that writes the config.
     *
     * The mutation is applied to a copy, the copy is written and validated by
     * xray, and the service is restarted only after xray has parsed it. The
     * panel's state follows the file, never the other way round.
     */
    const applyConfig = useCallback(
      async (mutate, { label, restart = true } = {}) => {
        if (!config) {
          say("danger", translate("There is no configuration to change."));
          return { ok: false };
        }
        if (!effective.configPath) {
          say("danger", translate("The configuration path is not set."));
          return { ok: false };
        }
        const next = JSON.parse(JSON.stringify(config));
        mutate(next);
        const json = JSON.stringify(next, null, 2);
        let result;
        try {
          result = await client.applyConfig({
            path: effective.configPath,
            json,
            bin: effective.bin,
            privilege: effective.privilege,
            unit: effective.unit,
            systemctl: effective.systemctl,
            restart,
          });
        } catch (error) {
          // A path the builders refuse is the caller's problem, not a failed
          // command: it is reported the same way, but nothing was written.
          say("danger", `${label}: ${errorText(error)}`);
          return { ok: false };
        }
        if (result.ok) {
          setConfig(next);
          say("success", result.restarted ? `${label} — ${translate("done")}` : `${label} — ${translate("written")}`);
        } else {
          say("danger", `${label}: ${failureText(result.failure)}`);
        }
        await load({ quiet: true });
        return result;
      },
      [config, client, effective, load, say, translate],
    );

    /** Runs an action with the busy flag and the notice, like the other panels. */
    const task = useCallback(
      async (key, label, run, { reload = true } = {}) => {
        markBusy(key, true);
        say("info", `${label}…`, { busy: true });
        try {
          const result = await run();
          if (result && result.ok === false) {
            say("danger", `${label}: ${failureText(result.failure)}`);
            return result;
          }
          if (result && result.message) {
            say("success", result.message);
          }
          return result;
        } catch (error) {
          say("danger", `${label}: ${errorText(error)}`);
          return { ok: false };
        } finally {
          markBusy(key, false);
          if (reload) {
            await load({ quiet: true });
          }
        }
      },
      [load, markBusy, say],
    );

    // --- groups -----------------------------------------------------------

    const saveGroup = useCallback(
      async (draft) => {
        const tag = String(draft.tag || "").trim();
        const selector = String(draft.selector || "")
          .split(",")
          .map((part) => part.trim())
          .filter(Boolean);
        const result = await applyConfig(
          (next) => {
            upsertGroup(next, {
              tag,
              selector,
              strategy: draft.strategy || "random",
              fallbackTag: String(draft.fallbackTag || "").trim(),
            });
          },
          { label: translate("Group") + ` ${tag}` },
        );
        if (result.ok) {
          setGroupState((current) => ({
            ...current,
            [tag]: { ...(current[tag] || {}), autoSelector: selector },
          }));
          overlays.closeModal();
        }
        return result;
      },
      [applyConfig, overlays, translate],
    );

    const requestDeleteGroup = useCallback(
      (group) => {
        overlays.openConfirm({
          title: translate("Delete the group"),
          description: translate(
            "The balancer is removed from the config. The nodes it selected stay in the config; only the group goes away.",
          ),
          command: `routing.balancers: ${group.tag}`,
          confirmLabel: translate("Delete"),
          run: async () => {
            const result = await applyConfig(
              (next) => {
                removeGroup(next, group.tag);
              },
              { label: translate("Delete group") + ` ${group.tag}` },
            );
            if (result.ok) {
              setGroupState((current) => {
                const next = { ...current };
                delete next[group.tag];
                return next;
              });
            }
            return result;
          },
        });
      },
      [applyConfig, overlays, translate],
    );

    /**
     * Selects a node.
     *
     * A balancer picks between the outbounds its selector matches. Selecting
     * a node therefore means narrowing that selector to that one outbound —
     * which is written to the config and survives a restart, unlike a
     * runtime override that a reboot would forget.
     */
    const selectNode = useCallback(
      async (group, node) => {
        if (!group || !node) {
          return { ok: false };
        }
        const result = await applyConfig(
          (next) => {
            setGroupSelector(next, group.tag, [node.tag]);
          },
          { label: `${translate("Select")} ${node.name || node.tag}` },
        );
        if (result.ok) {
          setGroupState((current) => ({
            ...current,
            [group.tag]: {
              ...(current[group.tag] || {}),
              autoSelector: group.autoSelector,
              pinnedTag: node.tag,
            },
          }));
        }
        return result;
      },
      [applyConfig, translate],
    );

    /** Hands the group back to its strategy. */
    const restoreAuto = useCallback(
      async (group) => {
        if (!group) {
          return { ok: false };
        }
        const selector = group.autoSelector || [];
        if (selector.length === 0) {
          say("danger", translate("This group's own selector is unknown — edit the group to set it."));
          return { ok: false };
        }
        const result = await applyConfig(
          (next) => {
            setGroupSelector(next, group.tag, selector);
          },
          { label: `${translate("Automatic")} ${group.tag}` },
        );
        if (result.ok) {
          setGroupState((current) => ({
            ...current,
            [group.tag]: { ...(current[group.tag] || {}), pinnedTag: "" },
          }));
        }
        return result;
      },
      [applyConfig, say, translate],
    );

    // --- subscriptions ----------------------------------------------------

    const saveSubscription = useCallback(
      (draft) => {
        const name = String(draft.name || "").trim();
        const url = String(draft.url || "").trim();
        const prefix = String(draft.prefix || "").trim() || slugify(name);
        const existing = draft.id
          ? subscriptions.find((subscription) => subscription.id === draft.id)
          : null;
        const record = {
          id: existing ? existing.id : newId(),
          name,
          url,
          prefix,
          updatedAt: existing ? existing.updatedAt : 0,
          nodeCount: existing ? existing.nodeCount : 0,
          format: existing ? existing.format : "",
          nodes: existing ? existing.nodes : [],
        };
        setSubscriptions((current) =>
          existing
            ? current.map((subscription) => (subscription.id === record.id ? record : subscription))
            : [...current, record],
        );
        overlays.closeModal();
        return { ok: true };
      },
      [overlays, subscriptions],
    );

    /**
     * Updates a subscription: the host downloads it, the panel reads it, and
     * the nodes it carries replace the ones the subscription owned before.
     */
    const updateSubscription = useCallback(
      async (subscription) => {
        if (!subscription) {
          return { ok: false };
        }
        const fetched = await client.fetchSubscription({
          url: subscription.url,
          tool: effective.fetchTool,
        });
        if (!fetched.ok) {
          say("danger", `${subscription.name}: ${failureText(fetched.failure)}`);
          return { ok: false };
        }
        const parsed = parseSubscription(fetched.text);
        if (!parsed.ok) {
          say("danger", `${subscription.name}: ${parsed.message}`);
          return { ok: false };
        }
        const result = await applyConfig(
          (next) => {
            replaceNodes(next, subscription.prefix, parsed.nodes);
          },
          { label: `${translate("Update")} ${subscription.name}` },
        );
        if (!result.ok) {
          return result;
        }
        const nodes = parsed.nodes.map((node, index) => {
          const endpoint = nodeEndpoint(node);
          return {
            tag: nodeTag(subscription.prefix, index),
            name: node.name || "",
            protocol: node.protocol,
            address: endpoint.address,
            port: endpoint.port,
          };
        });
        setSubscriptions((current) =>
          current.map((entry) =>
            entry.id === subscription.id
              ? {
                  ...entry,
                  updatedAt: Date.now(),
                  nodeCount: parsed.nodes.length,
                  format: parsed.format,
                  nodes,
                }
              : entry,
          ),
        );
        return {
          ok: true,
          message: `${subscription.name} — ${parsed.nodes.length} ${translate("nodes")}`,
        };
      },
      [applyConfig, client, effective.fetchTool, say, translate],
    );

    const requestDeleteSubscription = useCallback(
      (subscription) => {
        overlays.openConfirm({
          title: translate("Delete the subscription"),
          description: translate(
            "The subscription and the nodes it added to the config are removed.",
          ),
          command: subscription.url ? "subscription" : "",
          confirmLabel: translate("Delete"),
          run: async () => {
            const result = await applyConfig(
              (next) => {
                replaceNodes(next, subscription.prefix, []);
              },
              { label: translate("Delete subscription") + ` ${subscription.name}` },
            );
            if (result.ok) {
              setSubscriptions((current) =>
                current.filter((entry) => entry.id !== subscription.id),
              );
            }
            return result;
          },
        });
      },
      [applyConfig, overlays, translate],
    );

    // --- probes -----------------------------------------------------------

    /**
     * Measures the path the server is using right now: a request through the
     * local SOCKS inbound, so the selected node is the one being measured.
     */
    const probePath = useCallback(async () => {
      const ports = config ? inboundPorts(config) : { socks: null, http: null };
      const result = await client.probe({
        socksPort: ports.socks,
        url: prefs.probeUrl,
      });
      if (!result.ok) {
        say("danger", `${translate("Probe")}: ${failureText(result.failure)}`);
        return result;
      }
      say(
        "success",
        result.delay === null
          ? translate("The probe did not report a time.")
          : `${translate("Probe")} — ${result.delay} ms`,
      );
      return result;
    }, [client, config, prefs.probeUrl, say, translate]);

    // --- the confirm dialog ----------------------------------------------

    const runConfirm = useCallback(async () => {
      const request = overlays.confirm;
      overlays.closeConfirm();
      if (!request || typeof request.run !== "function") {
        return;
      }
      await task("confirm", request.confirmLabel || "Confirm", request.run, { reload: false });
    }, [overlays, task]);

    // --- navigation -------------------------------------------------------

    const openSettings = useCallback(() => {
      // The drafts start from what is in effect, so a cancelled visit leaves
      // nothing half-typed behind.
      prefs.setBinDraft(prefs.bin);
      prefs.setConfigPathDraft(prefs.configPath);
      prefs.setUnitDraft(prefs.unit);
      prefs.setPrivilegeDraft(prefs.privilege);
      overlays.openModal("settings", {
        bin: prefs.bin,
        configPath: prefs.configPath,
        unit: prefs.unit,
        privilege: prefs.privilege,
        probeUrl: prefs.probeUrl,
      });
    }, [overlays, prefs]);

    const dismissNotice = useCallback(() => setNotice(null), []);
    const refresh = useCallback(() => load(), [load]);

    return {
      // context
      locale,
      hasSession,
      hostLabel: (activeSession && activeSession.configName) || activeSessionId || "",
      translate,

      // preferences
      ...prefs,
      openSettings,

      // detection
      info,
      version,
      service,
      effective,
      loading,
      failure,
      config,
      summary,

      // model
      groups,
      subscriptions: subscriptionRows,
      activeGroup,
      activeNodes,
      delays: activeDelays,
      names,

      // ui state
      tab,
      setTab,
      query,
      setQuery,
      selectedGroup,
      setSelectedGroup,
      notice,
      dismissNotice,
      say,
      busy,
      isBusy,
      anyBusy: busy.size > 0,

      // overlays
      ...overlays,

      // actions
      client,
      load,
      refresh,
      applyConfig,
      task,
      saveGroup,
      requestDeleteGroup,
      selectNode,
      restoreAuto,
      saveSubscription,
      updateSubscription,
      requestDeleteSubscription,
      probePath,
      runConfirm,
    };
  };
}
