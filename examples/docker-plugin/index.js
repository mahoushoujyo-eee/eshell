// Docker panel for eShell.
//
// Scope: this plugin drives the `docker` CLI on the ACTIVE SSH SESSION through
// `eshell.sessions.execute`. The plugin facade has no local process or socket
// access, so this is a remote-host Docker view, not a Docker Desktop
// replacement — it talks to whatever daemon the connected host exposes.
//
// Everything it runs is built from a fixed verb plus an id that came back from
// docker itself, and every id/reference is validated before it reaches the
// command line (see `docker.js`). No `docker exec`, no shell interpolation of
// user input.
import { createDockerClient, describeDockerFailure } from "./docker.js";

const PANEL_ID = "com.example.docker.panel";
const TITLE = "Docker";
const LOG_TAIL_OPTIONS = [100, 200, 1000, 5000];
const LOG_POLL_MS = 3000;

const failureText = (failure) => describeDockerFailure(failure).text;

const stateTone = (state) => {
  if (state === "running") return "text-success";
  if (state === "paused") return "text-warning";
  return "text-muted";
};

export async function activate(eshell) {
  const { createElement: h, useCallback, useEffect, useMemo, useRef, useState } =
    eshell.react;

  // --- controller ---------------------------------------------------------
  // One controller per activation; the panel reads its output. All docker
  // traffic lives here so the panel stays a pure render of that state.
  function useDockerController({ api, activeSessionId, activeSession }) {
    const [tab, setTab] = useState("containers");
    const [containers, setContainers] = useState([]);
    const [images, setImages] = useState([]);
    const [diskRows, setDiskRows] = useState([]);
    const [loading, setLoading] = useState(false);
    const [failure, setFailure] = useState(null);
    const [busyId, setBusyId] = useState(null);
    const [notice, setNotice] = useState(null);
    const [logs, setLogs] = useState(null);
    const [tail, setTail] = useState(200);
    const [follow, setFollow] = useState(false);
    const [inspect, setInspect] = useState(null);
    const [pullRef, setPullRef] = useState("");

    // Discards results from a superseded request: switching sessions or
    // hitting refresh twice must not let an older listing win.
    const requestRef = useRef(0);

    // One client per session: `execute` is bound to the session the panel is
    // currently showing, so a stale client can never write to a new session.
    const client = useMemo(
      () =>
        createDockerClient((command) => {
          if (!activeSessionId) {
            return Promise.reject(new Error("no active session"));
          }
          return api.sessions.execute(activeSessionId, command);
        }),
      [api, activeSessionId],
    );

    const refresh = useCallback(async () => {
      if (!activeSessionId) {
        setContainers([]);
        setImages([]);
        setDiskRows([]);
        setFailure(null);
        return;
      }
      const token = ++requestRef.current;
      setLoading(true);
      try {
        const result = await client.list();
        if (token !== requestRef.current) return;
        setContainers(result.containers);
        setImages(result.images);
        setFailure(result.failure);
      } catch (error) {
        if (token !== requestRef.current) return;
        setFailure({ kind: "error", message: String(error?.message ?? error) });
      } finally {
        if (token === requestRef.current) setLoading(false);
      }
    }, [activeSessionId, client]);

    const loadDisk = useCallback(async () => {
      if (!activeSessionId) return;
      try {
        const result = await client.diskUsage();
        setDiskRows(result.rows);
        if (result.failure) setNotice({ tone: "danger", text: failureText(result.failure) });
      } catch (error) {
        setNotice({ tone: "danger", text: String(error?.message ?? error) });
      }
    }, [activeSessionId, client]);

    // Re-list whenever the active session changes, and once on mount.
    useEffect(() => {
      refresh();
    }, [refresh]);

    // Disk usage is only fetched when its tab is actually open: it is the
    // most expensive call here and nothing else needs it.
    useEffect(() => {
      if (tab === "disk") loadDisk();
    }, [tab, loadDisk]);

    // Log follow. The interval is cleared on close, on session change and on
    // unmount; `logs.id` is the only thing it re-reads.
    const logsId = logs?.id ?? null;
    useEffect(() => {
      if (!follow || !logsId) return undefined;
      const timer = setInterval(async () => {
        try {
          const text = await client.logs(logsId, tail);
          setLogs((current) => (current && current.id === logsId ? { ...current, text } : current));
        } catch {
          // A failed poll keeps the last good text; the next tick retries.
        }
      }, LOG_POLL_MS);
      return () => clearInterval(timer);
    }, [follow, logsId, tail, client]);

    const runAction = useCallback(
      async (action, container) => {
        setBusyId(container.id);
        setNotice(null);
        try {
          const result = await client.action(action, container.id);
          setNotice(
            result.ok
              ? { tone: "success", text: `${action} ${container.name}` }
              : {
                  tone: "danger",
                  text: `${action} ${container.name}: ${failureText(result.failure)}`,
                },
          );
          await refresh();
        } catch (error) {
          setNotice({ tone: "danger", text: String(error?.message ?? error) });
        } finally {
          setBusyId(null);
        }
      },
      [client, refresh],
    );

    const openLogs = useCallback(
      async (container) => {
        setBusyId(container.id);
        setNotice(null);
        try {
          const text = await client.logs(container.id, tail);
          setLogs({ id: container.id, name: container.name, text });
        } catch (error) {
          setNotice({ tone: "danger", text: String(error?.message ?? error) });
        } finally {
          setBusyId(null);
        }
      },
      [client, tail],
    );

    const reloadLogs = useCallback(async () => {
      if (!logsId) return;
      try {
        const text = await client.logs(logsId, tail);
        setLogs((current) => (current && current.id === logsId ? { ...current, text } : current));
      } catch (error) {
        setNotice({ tone: "danger", text: String(error?.message ?? error) });
      }
    }, [client, logsId, tail]);

    const closeLogs = useCallback(() => {
      setFollow(false);
      setLogs(null);
    }, []);

    const openInspect = useCallback(
      async (container) => {
        setBusyId(container.id);
        setNotice(null);
        try {
          const result = await client.inspect(container.id);
          if (result.failure) {
            setNotice({ tone: "danger", text: failureText(result.failure) });
            return;
          }
          setInspect({ id: container.id, name: container.name, ...result });
        } catch (error) {
          setNotice({ tone: "danger", text: String(error?.message ?? error) });
        } finally {
          setBusyId(null);
        }
      },
      [client],
    );

    const closeInspect = useCallback(() => setInspect(null), []);

    const pullImage = useCallback(async () => {
      const reference = pullRef.trim();
      if (!reference) return;
      setBusyId(reference);
      setNotice({ tone: "info", text: `pulling ${reference}…` });
      try {
        const result = await client.pull(reference);
        setNotice(
          result.ok
            ? { tone: "success", text: `pulled ${reference}` }
            : { tone: "danger", text: `pull ${reference}: ${failureText(result.failure)}` },
        );
        if (result.ok) setPullRef("");
        await refresh();
      } catch (error) {
        setNotice({ tone: "danger", text: String(error?.message ?? error) });
      } finally {
        setBusyId(null);
      }
    }, [client, pullRef, refresh]);

    const removeImage = useCallback(
      async (image) => {
        setBusyId(image.id);
        setNotice(null);
        try {
          const result = await client.removeImage(image.id);
          setNotice(
            result.ok
              ? { tone: "success", text: `removed ${image.reference}` }
              : { tone: "danger", text: `remove ${image.reference}: ${failureText(result.failure)}` },
          );
          await refresh();
        } catch (error) {
          setNotice({ tone: "danger", text: String(error?.message ?? error) });
        } finally {
          setBusyId(null);
        }
      },
      [client, refresh],
    );

    const pruneImages = useCallback(async () => {
      setBusyId("prune");
      setNotice(null);
      try {
        const result = await client.pruneImages();
        setNotice(
          result.ok
            ? { tone: "success", text: result.output || "pruned unused images" }
            : { tone: "danger", text: `prune: ${failureText(result.failure)}` },
        );
        await refresh();
        if (tab === "disk") await loadDisk();
      } catch (error) {
        setNotice({ tone: "danger", text: String(error?.message ?? error) });
      } finally {
        setBusyId(null);
      }
    }, [client, refresh, loadDisk, tab]);

    return {
      tab,
      setTab,
      containers,
      images,
      diskRows,
      loading,
      failure,
      busyId,
      notice,
      logs,
      tail,
      setTail,
      follow,
      setFollow,
      inspect,
      pullRef,
      setPullRef,
      hostLabel: activeSession?.configName || activeSessionId || "",
      hasSession: Boolean(activeSessionId),
      refresh,
      loadDisk,
      runAction,
      openLogs,
      reloadLogs,
      closeLogs,
      openInspect,
      closeInspect,
      pullImage,
      removeImage,
      pruneImages,
    };
  }

  // --- small presentational pieces ---------------------------------------
  const buttonClass =
    "rounded-md border border-border px-2 py-0.5 text-xs transition-colors hover:bg-accent-soft disabled:cursor-not-allowed disabled:opacity-40";

  const ActionButton = ({ label, onClick, disabled, title }) =>
    h(
      "button",
      { type: "button", className: buttonClass, onClick, disabled, title: title || label },
      label,
    );

  const TabButton = ({ id, label, count, tab, onSelect }) =>
    h(
      "button",
      {
        type: "button",
        className: `rounded-md px-2 py-0.5 text-xs transition-colors ${
          tab === id ? "bg-accent-soft text-text" : "text-muted hover:text-text"
        }`,
        onClick: () => onSelect(id),
      },
      count === undefined ? label : `${label} ${count}`,
    );

  const EmptyState = ({ children }) =>
    h(
      "div",
      { className: "flex h-full items-center justify-center p-6 text-xs text-muted" },
      children,
    );

  const Notice = ({ notice }) =>
    notice
      ? h(
          "div",
          {
            className: `shrink-0 border-b border-border px-3 py-1 text-xs ${
              notice.tone === "success"
                ? "text-success"
                : notice.tone === "info"
                  ? "text-muted"
                  : "text-danger"
            }`,
          },
          notice.text,
        )
      : null;

  const Overlay = ({ title, actions, children }) =>
    h(
      "div",
      { className: "absolute inset-0 flex flex-col bg-panel" },
      h(
        "div",
        {
          className:
            "flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-2",
        },
        h("span", { className: "truncate text-xs font-medium" }, title),
        h("div", { className: "flex shrink-0 items-center gap-1" }, actions),
      ),
      children,
    );

  // A container's available actions depend on its state: `docker rm` refuses
  // a running container, and pause/unpause only make sense on a live one.
  const containerActions = (container, busy, onAction, onLogs, onInspect) => {
    const isBusy = busy === container.id;
    const buttons = [];
    if (container.paused) {
      buttons.push(["Unpause", () => onAction("unpause", container)]);
    } else if (container.running) {
      buttons.push(["Stop", () => onAction("stop", container)]);
      buttons.push(["Pause", () => onAction("pause", container)]);
    } else {
      buttons.push(["Start", () => onAction("start", container)]);
    }
    buttons.push(["Restart", () => onAction("restart", container)]);
    buttons.push(["Logs", () => onLogs(container)]);
    buttons.push(["Inspect", () => onInspect(container)]);
    // `docker rm` refuses both a running and a paused container, so Remove
    // only appears where it can actually succeed.
    if (!container.running && !container.paused) {
      buttons.push(["Remove", () => onAction("rm", container)]);
    }
    return h(
      "div",
      { className: "flex shrink-0 gap-1" },
      buttons.map(([label, onClick]) =>
        h(ActionButton, { key: label, label, onClick, disabled: isBusy }),
      ),
    );
  };

  const ContainerRow = ({ container, busy, onAction, onLogs, onInspect }) =>
    h(
      "div",
      { className: "flex items-center gap-2 border-b border-border px-3 py-1.5 text-xs" },
      h("span", {
        className: `h-2 w-2 shrink-0 rounded-full ${container.running ? "bg-success" : "bg-muted"}`,
        title: container.state,
      }),
      h(
        "span",
        { className: "w-40 shrink-0 truncate font-medium", title: container.name },
        container.name,
      ),
      h("span", { className: "flex-1 truncate text-muted", title: container.image }, container.image),
      h(
        "span",
        {
          className: `w-28 shrink-0 truncate ${stateTone(container.state)}`,
          title: container.status,
        },
        container.status || container.state,
      ),
      containerActions(container, busy, onAction, onLogs, onInspect),
    );

  const ImageRow = ({ image, busy, onRemove }) =>
    h(
      "div",
      { className: "flex items-center gap-2 border-b border-border px-3 py-1.5 text-xs" },
      h("span", { className: "w-24 shrink-0 font-mono text-muted" }, image.id.slice(0, 12)),
      h("span", { className: "flex-1 truncate", title: image.reference }, image.reference),
      h("span", { className: "w-20 shrink-0 text-right text-muted" }, image.size),
      h("span", { className: "w-28 shrink-0 text-right text-muted" }, image.createdSince),
      h(
        "div",
        { className: "flex shrink-0 gap-1" },
        h(ActionButton, {
          label: "Remove",
          disabled: busy === image.id,
          title: `docker rmi ${image.reference}`,
          onClick: () => onRemove(image),
        }),
      ),
    );

  const LogsOverlay = ({ logs: current, tail: currentTail, follow, setTail, setFollow, onReload, onClose }) =>
    h(
      Overlay,
      {
        title: `logs · ${current.name}`,
        actions: [
          h(
            "select",
            {
              key: "tail",
              className: "rounded-md border border-border bg-panel px-1 py-0.5 text-xs",
              value: String(currentTail),
              onChange: (event) => setTail(Number(event.target.value)),
              title: "Number of trailing lines",
            },
            LOG_TAIL_OPTIONS.map((option) =>
              h("option", { key: option, value: String(option) }, `last ${option}`),
            ),
          ),
          h(
            "label",
            {
              key: "follow",
              className: "flex items-center gap-1 text-xs text-muted",
              title: `Re-read every ${LOG_POLL_MS / 1000}s`,
            },
            h("input", {
              type: "checkbox",
              checked: follow,
              onChange: (event) => setFollow(event.target.checked),
            }),
            "follow",
          ),
          h(ActionButton, { key: "reload", label: "Reload", onClick: onReload }),
          h(ActionButton, { key: "close", label: "Close", onClick: onClose }),
        ],
      },
      h(
        "pre",
        {
          className:
            "flex-1 overflow-auto whitespace-pre-wrap break-all p-3 font-mono text-[11px] leading-relaxed",
        },
        current.text,
      ),
    );

  const InspectOverlay = ({ inspect: current, onClose }) => {
    const s = current.summary;
    const row = (label, value) =>
      value
        ? h(
            "div",
            { className: "flex gap-2 py-0.5" },
            h("span", { className: "w-28 shrink-0 text-muted" }, label),
            h("span", { className: "flex-1 break-all" }, value),
          )
        : null;
    return h(
      Overlay,
      {
        title: `inspect · ${current.name}`,
        actions: [h(ActionButton, { key: "close", label: "Close", onClick: onClose })],
      },
      h(
        "div",
        { className: "flex-1 overflow-auto p-3 text-xs" },
        s
          ? h(
              "div",
              { className: "mb-3" },
              row("Id", s.id.slice(0, 12)),
              row("Image", s.image),
              row("Status", s.health ? `${s.status} (${s.health})` : s.status),
              row("Started", s.startedAt),
              row("Exit code", s.exitCode === undefined ? "" : String(s.exitCode)),
              row("Restart", s.restartPolicy === "no" ? "" : s.restartPolicy),
              row("Command", s.command),
              row("Ports", s.ports.join(", ")),
              row("Mounts", s.mounts.join(", ")),
              row("Networks", s.networks.join(", ")),
            )
          : h("p", { className: "mb-3 text-muted" }, "Could not parse the inspect output."),
        h(
          "details",
          null,
          h("summary", { className: "cursor-pointer text-muted" }, "Raw JSON"),
          h(
            "pre",
            {
              className:
                "mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-md border border-border bg-surface p-2 font-mono text-[11px] text-muted",
            },
            current.raw,
          ),
        ),
      ),
    );
  };

  // --- panel --------------------------------------------------------------
  const renderPanel = ({ controller }) => {
    const c = controller;

    const body = !c.hasSession
      ? h(EmptyState, null, "Open an SSH session to inspect Docker on that host.")
      : c.failure
        ? h(
            "div",
            { className: "p-4 text-xs" },
            h("p", { className: "text-danger" }, failureText(c.failure)),
            h("p", { className: "mt-1 text-muted" }, describeDockerFailure(c.failure).hint),
            h(
              "p",
              { className: "mt-2 text-muted" },
              "This panel runs the docker CLI on the active session's host.",
            ),
            // The raw stderr stays visible: the exact path in a socket
            // permission error is what distinguishes the cases.
            c.failure.detail
              ? h(
                  "pre",
                  {
                    className:
                      "mt-3 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md border border-border bg-surface p-2 font-mono text-[11px] text-muted",
                  },
                  c.failure.detail,
                )
              : null,
          )
        : c.tab === "containers"
          ? c.containers.length === 0
            ? h(EmptyState, null, c.loading ? "Loading…" : "No containers on this host.")
            : h(
                "div",
                { className: "flex-1 overflow-auto" },
                c.containers.map((container) =>
                  h(ContainerRow, {
                    key: container.id,
                    container,
                    busy: c.busyId,
                    onAction: c.runAction,
                    onLogs: c.openLogs,
                    onInspect: c.openInspect,
                  }),
                ),
              )
          : c.tab === "images"
            ? h(
                "div",
                { className: "flex min-h-0 flex-1 flex-col" },
                h(
                  "div",
                  { className: "flex shrink-0 items-center gap-2 border-b border-border px-3 py-2" },
                  h("input", {
                    type: "text",
                    value: c.pullRef,
                    placeholder: "nginx:1.27",
                    className:
                      "flex-1 rounded-md border border-border bg-surface px-2 py-0.5 text-xs",
                    onChange: (event) => c.setPullRef(event.target.value),
                    onKeyDown: (event) => {
                      if (event.key === "Enter") c.pullImage();
                    },
                  }),
                  h(ActionButton, {
                    label: "Pull",
                    disabled: !c.pullRef.trim() || c.busyId === c.pullRef.trim(),
                    onClick: c.pullImage,
                  }),
                  h(ActionButton, {
                    label: "Prune unused",
                    disabled: c.busyId === "prune",
                    title: "docker image prune -f — removes dangling images only",
                    onClick: c.pruneImages,
                  }),
                ),
                c.images.length === 0
                  ? h(EmptyState, null, c.loading ? "Loading…" : "No images on this host.")
                  : h(
                      "div",
                      { className: "flex-1 overflow-auto" },
                      c.images.map((image) =>
                        h(ImageRow, {
                          key: `${image.id}-${image.reference}`,
                          image,
                          busy: c.busyId,
                          onRemove: c.removeImage,
                        }),
                      ),
                    ),
              )
            : h(
                "div",
                { className: "flex-1 overflow-auto" },
                c.diskRows.length === 0
                  ? h(EmptyState, null, "No disk usage reported.")
                  : h(
                      "div",
                      { className: "p-3 text-xs" },
                      h(
                        "div",
                        {
                          className:
                            "flex gap-2 border-b border-border pb-1 font-medium text-muted",
                        },
                        h("span", { className: "w-24 shrink-0" }, "Type"),
                        h("span", { className: "w-16 shrink-0 text-right" }, "Count"),
                        h("span", { className: "w-24 shrink-0 text-right" }, "Size"),
                        h("span", { className: "flex-1 text-right" }, "Reclaimable"),
                      ),
                      c.diskRows.map((row) =>
                        h(
                          "div",
                          { key: row.type, className: "flex gap-2 border-b border-border py-1" },
                          h("span", { className: "w-24 shrink-0" }, row.type),
                          h("span", { className: "w-16 shrink-0 text-right" }, row.count),
                          h("span", { className: "w-24 shrink-0 text-right" }, row.size),
                          h("span", { className: "flex-1 text-right text-muted" }, row.reclaimable),
                        ),
                      ),
                    ),
              );

    return h(
      "section",
      {
        className: "relative flex h-full min-h-0 flex-col bg-panel text-text",
        "aria-label": TITLE,
      },
      h(
        "div",
        {
          className:
            "flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-2",
        },
        h(
          "div",
          { className: "flex min-w-0 items-center gap-2" },
          h("span", { className: "text-sm font-semibold" }, TITLE),
          h(
            "span",
            { className: "truncate text-xs text-muted" },
            c.hostLabel ? `on ${c.hostLabel}` : "no active session",
          ),
        ),
        h(
          "div",
          { className: "flex shrink-0 items-center gap-1" },
          h(TabButton, {
            id: "containers",
            label: "Containers",
            count: c.containers.length,
            tab: c.tab,
            onSelect: c.setTab,
          }),
          h(TabButton, {
            id: "images",
            label: "Images",
            count: c.images.length,
            tab: c.tab,
            onSelect: c.setTab,
          }),
          h(TabButton, { id: "disk", label: "Disk", tab: c.tab, onSelect: c.setTab }),
          h(ActionButton, {
            label: c.loading ? "…" : "Refresh",
            disabled: c.loading || !c.hasSession,
            onClick: c.refresh,
          }),
        ),
      ),
      h(Notice, { notice: c.notice }),
      body,
      c.logs
        ? h(LogsOverlay, {
            logs: c.logs,
            tail: c.tail,
            follow: c.follow,
            setTail: c.setTail,
            setFollow: c.setFollow,
            onReload: c.reloadLogs,
            onClose: c.closeLogs,
          })
        : null,
      c.inspect ? h(InspectOverlay, { inspect: c.inspect, onClose: c.closeInspect }) : null,
    );
  };

  const disposeController = eshell.ui.registerController(useDockerController);

  const disposePanel = eshell.ui.registerPanel({
    id: PANEL_ID,
    key: PANEL_ID,
    title: TITLE,
    order: 40,
    // Left at the default: the panel starts hidden and the toolbar button
    // opens it. A panel that opened itself would do so on every launch,
    // because panel visibility is not persisted.
    render: renderPanel,
  });

  const disposeToolbar = eshell.ui.registerToolbar({
    id: "com.example.docker.toolbar",
    key: "com.example.docker.toolbar",
    panelId: PANEL_ID,
    label: TITLE,
    // `import.meta.url` resolves to this module's own `plugin://` URL, so the
    // icon ships next to the code and needs no host-side registration. A
    // bare name from the host's icon set ("container", "server", …) works
    // too; a URL is what lets a plugin use its own artwork.
    icon: new URL("./icon.svg", import.meta.url).href,
    order: 40,
  });

  eshell.log.info("docker panel activated");
  return () => {
    disposeToolbar();
    disposePanel();
    disposeController();
    eshell.log.info("docker panel deactivated");
  };
}
