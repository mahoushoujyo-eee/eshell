// The System tab: `docker info` / `docker version` as tiles and a key/value
// block, `docker system df` as a table, and every `prune` variant behind one
// menu — each with its own confirmation naming what it deletes.

import { humanBytes } from "./format.js";

export function createSystemTab({ h, ui, t }) {
  const { Button, KeyValue, Menu, StatTile } = ui;

  const DF_GRID = "grid grid-cols-[minmax(90px,1fr)_70px_70px_90px_minmax(90px,1fr)] gap-2";

  const pruneItems = (c) => {
    const item = (key, label, command, body, run) => ({
      key,
      label,
      hint: command.replace(/^docker /, ""),
      tone: "danger",
      onClick: () =>
        c.askConfirm({ title: label, body, command, confirmLabel: t("Prune"), tone: "danger", run }),
    });
    const prune = (label, call) => () => c.task("prune", label, call);

    return [
      item(
        "containers",
        t("Remove stopped containers"),
        "docker container prune -f",
        t("Every stopped container is removed."),
        prune(t("Remove stopped containers"), () => c.client.pruneContainers()),
      ),
      item(
        "images",
        t("Remove dangling images"),
        "docker image prune -f",
        t("Only untagged layers are removed."),
        prune(t("Remove dangling images"), () => c.client.pruneImages()),
      ),
      item(
        "imagesAll",
        t("Remove all unused images"),
        "docker image prune -a -f",
        t("Every image no container references is removed, including tagged ones."),
        prune(t("Remove all unused images"), () => c.client.pruneImages({ all: true })),
      ),
      item(
        "volumes",
        t("Remove unused volumes"),
        "docker volume prune -f",
        t("Volume data is deleted and cannot be recovered."),
        prune(t("Remove unused volumes"), () => c.client.pruneVolumes()),
      ),
      item(
        "networks",
        t("Remove unused networks"),
        "docker network prune -f",
        t("Networks with no attached container are removed."),
        prune(t("Remove unused networks"), () => c.client.pruneNetworks()),
      ),
      item(
        "builder",
        t("Clear the build cache"),
        "docker builder prune -f",
        t("Cached build layers are removed; the next build is slower."),
        prune(t("Clear the build cache"), () => c.client.pruneBuilder()),
      ),
      { separator: true },
      item(
        "system",
        t("System prune (everything unused)"),
        "docker system prune -f",
        t("Stopped containers, unused networks, dangling images and the build cache are all removed."),
        prune(t("System prune"), () => c.client.pruneSystem()),
      ),
    ];
  };

  const Tiles = ({ info, version }) =>
    h(
      "div",
      { className: "grid gap-2 sm:grid-cols-2 lg:grid-cols-4" },
      h(StatTile, {
        label: t("Server version"),
        value: (info && info.serverVersion) || (version && version.serverVersion) || "—",
        hint: info ? `${info.osType}/${info.architecture}` : "",
        tone: info && info.live ? "success" : "danger",
      }),
      h(StatTile, {
        label: t("Containers"),
        value: info ? String(info.containers ?? "—") : "—",
        hint: info
          ? t("{running} running · {paused} paused · {stopped} stopped", {
              running: info.containersRunning ?? 0,
              paused: info.containersPaused ?? 0,
              stopped: info.containersStopped ?? 0,
            })
          : "",
        tone: "info",
      }),
      h(StatTile, {
        label: t("Images"),
        value: info ? String(info.images ?? "—") : "—",
        hint: (info && info.storageDriver) || "",
      }),
      h(StatTile, {
        label: t("Host resources"),
        value: info ? `${info.cpus ?? "—"} CPU` : "—",
        hint: info ? humanBytes(info.memTotal) : "",
      }),
    );

  const DiskUsage = ({ rows }) =>
    h(
      "div",
      { className: "mt-3 rounded-lg border border-border" },
      h(
        "p",
        {
          className:
            "border-b border-border px-3 py-1.5 text-[10px] tracking-wide text-muted uppercase",
        },
        t("Disk usage"),
      ),
      rows.length === 0
        ? h("p", { className: "px-3 py-2 text-[11px] text-muted" }, t("No disk usage reported."))
        : h(
            "div",
            { className: "px-3 py-2" },
            h(
              "div",
              {
                className: `${DF_GRID} border-b border-border pb-1 text-[10px] tracking-wide text-muted uppercase`,
              },
              h("span", null, t("Type")),
              h("span", { className: "text-right" }, t("Total")),
              h("span", { className: "text-right" }, t("Active")),
              h("span", { className: "text-right" }, t("Size")),
              h("span", { className: "text-right" }, t("Reclaimable")),
            ),
            rows.map((row) =>
              h(
                "div",
                {
                  key: row.type,
                  className: `${DF_GRID} border-b border-border/40 py-1 text-[11px] tabular-nums last:border-0`,
                },
                h("span", { className: "font-medium" }, row.type),
                h("span", { className: "text-right text-muted" }, row.total),
                h("span", { className: "text-right text-muted" }, row.active),
                h("span", { className: "text-right" }, row.size),
                h("span", { className: "text-right text-muted" }, row.reclaimable),
              ),
            ),
          ),
    );

  return function SystemTab({ c }) {
    const { info, version } = c;
    return h(
      "div",
      { className: "min-h-0 flex-1 overflow-auto p-3" },
      h(Tiles, { info, version }),
      info && info.warnings.length
        ? h(
            "div",
            { className: "mt-3 rounded-lg border border-border px-3 py-2" },
            h(
              "p",
              { className: "text-[10px] tracking-wide text-warning uppercase" },
              t("Daemon warnings"),
            ),
            info.warnings.map((warning, index) =>
              h("p", { key: index, className: "mt-0.5 text-[11px] text-muted" }, warning),
            ),
          )
        : null,
      h(
        "div",
        { className: "mt-3 flex flex-wrap items-center gap-1.5" },
        h(Button, {
          label: t("docker system df -v"),
          size: "xs",
          onClick: () =>
            c.openText(t("Disk usage (verbose)"), "docker system df -v", () =>
              c.client.diskUsageVerbose(),
            ),
        }),
        h(Menu, { label: t("Prune…"), size: "sm", tone: "default", items: pruneItems(c) }),
      ),
      h(DiskUsage, { rows: c.diskRows }),
      h(
        "div",
        { className: "mt-3 rounded-lg border border-border p-3" },
        h("p", { className: "mb-2 text-[10px] tracking-wide text-muted uppercase" }, t("Daemon")),
        h(KeyValue, {
          columns: 2,
          rows: [
            { label: t("Host name"), value: info && info.name },
            { label: t("Operating system"), value: info && info.operatingSystem },
            { label: t("Kernel"), value: info && info.kernelVersion },
            { label: t("Storage driver"), value: info && info.storageDriver },
            { label: t("Logging driver"), value: info && info.loggingDriver },
            {
              label: t("Cgroup"),
              value: info && [info.cgroupDriver, info.cgroupVersion].filter(Boolean).join(" v"),
            },
            { label: t("Root dir"), value: info && info.rootDir, mono: true },
            { label: t("Client"), value: version && version.clientVersion },
            { label: t("API"), value: version && version.serverApi },
            { label: t("CLI prefix"), value: c.bin, mono: true },
          ],
        }),
      ),
    );
  };
}
