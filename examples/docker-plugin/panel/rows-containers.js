// The container table: its columns, its per-row action menu, and the bulk
// action bar. Every button names the exact CLI invocation in its `title`, so
// the panel stays legible as a docker UI rather than hiding what it runs.

import { containerActionCommand, containerLogsCommand } from "../docker.js";
import { copyText, meterTone, stateTone } from "./format.js";

export function createContainerRows({ h, ui, t }) {
  const { Button, Dot, Menu, Meter, Pill } = ui;

  const logTarget = (c, container) => ({
    kind: "container",
    reference: container.id,
    title: container.name,
    command: containerLogsCommand(container.id, { tail: c.logTail }, { bin: c.bin }),
  });

  /** One lifecycle action, optionally behind a confirmation. */
  const lifecycle = (c, container, action, label, options, confirmTitle) => ({
    key: `${action}${options && options.force ? ":force" : ""}`,
    label,
    hint: `docker ${action}`,
    tone: action === "rm" || action === "kill" ? "danger" : undefined,
    onClick: () => {
      const run = () =>
        c.task(container.id, `docker ${action} ${container.name}`, () =>
          c.client.containerAction(action, container.id, options),
        );
      if (!confirmTitle) {
        run();
        return;
      }
      c.askConfirm({
        title: confirmTitle,
        description: t("This runs on {host}.", { host: c.hostLabel }),
        command: containerActionCommand(action, container.id, { ...options, bin: c.bin }),
        confirmLabel: label,
        tone: "danger",
        run,
      });
    },
  });

  const menuItems = (c, container) =>
    [
      container.running ? lifecycle(c, container, "restart", t("Restart")) : null,
      container.paused ? lifecycle(c, container, "unpause", t("Unpause")) : null,
      container.running && !container.paused ? lifecycle(c, container, "pause", t("Pause")) : null,
      container.running
        ? lifecycle(c, container, "kill", t("Kill"), {}, t("Kill this container?"))
        : null,
      { separator: true },
      {
        key: "logs",
        label: t("Logs"),
        hint: "docker logs",
        onClick: () => c.openLogs(logTarget(c, container)),
      },
      {
        key: "inspect",
        label: t("Inspect"),
        hint: "docker inspect",
        onClick: () => c.openInspect("container", container.id, container.name),
      },
      {
        key: "exec",
        label: t("Exec"),
        hint: "docker exec",
        disabled: !container.running,
        onClick: () => c.openExec(container),
      },
      {
        key: "top",
        label: t("Processes"),
        hint: "docker top",
        disabled: !container.running,
        onClick: () =>
          c.openText(`${t("Processes")} · ${container.name}`, "docker top", () =>
            c.client.top(container.id),
          ),
      },
      {
        key: "diff",
        label: t("Filesystem diff"),
        hint: "docker diff",
        onClick: () =>
          c.openText(`${t("Filesystem diff")} · ${container.name}`, "docker diff", () =>
            c.client.diff(container.id),
          ),
      },
      {
        key: "port",
        label: t("Port mappings"),
        hint: "docker port",
        onClick: () =>
          c.openText(`${t("Port mappings")} · ${container.name}`, "docker port", () =>
            c.client.ports(container.id),
          ),
      },
      { separator: true },
      {
        key: "rename",
        label: t("Rename…"),
        hint: "docker rename",
        onClick: () =>
          c.openModal({ kind: "rename", reference: container.id, current: container.name }),
      },
      { key: "copy", label: t("Copy container id"), onClick: () => copyText(container.id) },
      { separator: true },
      // `docker rm` refuses a running or paused container, so only the variant
      // that can actually succeed is offered.
      container.removable
        ? lifecycle(c, container, "rm", t("Remove"), {}, t("Remove this container?"))
        : lifecycle(
            c,
            container,
            "rm",
            t("Force remove"),
            { force: true },
            t("Force-remove a running container?"),
          ),
    ].filter(Boolean);

  const nameCell = (container) =>
    h(
      "div",
      { className: "flex min-w-0 items-center gap-1.5" },
      h(Dot, {
        tone: stateTone(container.state),
        title: container.state,
        pulse: container.state === "restarting",
      }),
      h("span", { className: "truncate font-medium", title: container.name }, container.name),
      container.composeService
        ? h(
            Pill,
            { tone: "info", title: `${container.composeProject}/${container.composeService}` },
            container.composeProject,
          )
        : null,
    );

  const actionsCell = (c, container) =>
    h(
      "div",
      { className: "flex items-center justify-end gap-1" },
      container.running || container.paused
        ? h(Button, {
            label: t("Stop"),
            size: "xs",
            title: `docker stop ${container.name}`,
            busy: c.isBusy(container.id),
            onClick: () =>
              c.task(container.id, `docker stop ${container.name}`, () =>
                c.client.containerAction("stop", container.id),
              ),
          })
        : h(Button, {
            label: t("Start"),
            size: "xs",
            title: `docker start ${container.name}`,
            busy: c.isBusy(container.id),
            onClick: () =>
              c.task(container.id, `docker start ${container.name}`, () =>
                c.client.containerAction("start", container.id),
              ),
          }),
      h(Button, {
        label: t("Logs"),
        size: "xs",
        title: `docker logs ${container.name}`,
        onClick: () => c.openLogs(logTarget(c, container)),
      }),
      h(Menu, { items: menuItems(c, container) }),
    );

  const containerColumns = (c) => {
    const columns = [
      { key: "name", label: t("Name"), width: "minmax(150px,1.3fr)", render: nameCell },
      {
        key: "image",
        label: t("Image"),
        width: "minmax(120px,1.2fr)",
        render: (container) =>
          h(
            "span",
            {
              className: "truncate text-muted",
              title: `${container.image}\n${container.command}`,
            },
            container.image,
          ),
      },
      {
        key: "status",
        label: t("Status"),
        width: "minmax(110px,1fr)",
        render: (container) =>
          h(
            "span",
            { className: "truncate", title: `${container.state} — ${container.status}` },
            container.status || container.state,
          ),
      },
      {
        key: "ports",
        label: t("Ports"),
        width: "minmax(100px,1fr)",
        render: (container) =>
          h(
            "span",
            { className: "truncate text-muted", title: container.ports },
            container.ports || "—",
          ),
      },
    ];

    if (c.statsEnabled) {
      columns.push(
        {
          key: "cpu",
          label: t("CPU"),
          width: "90px",
          render: (container) =>
            container.stats
              ? h(Meter, {
                  percent: container.stats.cpuPercent,
                  tone: meterTone(container.stats.cpuPercent || 0),
                  label: container.stats.cpuText,
                })
              : h("span", { className: "text-muted" }, "—"),
        },
        {
          key: "mem",
          label: t("Memory"),
          width: "130px",
          render: (container) =>
            h(
              "span",
              { className: "truncate text-muted", title: container.stats?.memUsage },
              container.stats ? container.stats.memUsage : "—",
            ),
        },
      );
    }

    columns.push({
      key: "actions",
      label: "",
      width: "168px",
      render: (container) => actionsCell(c, container),
    });
    return columns;
  };

  /** Appears only when rows are selected; every verb is a real docker verb. */
  const SelectionBar = ({ c }) => {
    if (c.selection.size === 0) {
      return null;
    }
    const refs = [...c.selection];
    const names = refs.map((id) => {
      const found = c.allContainers.find((container) => container.id === id);
      return (found && found.name) || id.slice(0, 12);
    });
    const preview = `${names.slice(0, 3).join(" ")}${names.length > 3 ? " …" : ""}`;
    const bulk = (action, label, options) =>
      h(Button, {
        key: action,
        label,
        size: "xs",
        tone: action === "rm" ? "danger" : "default",
        title: `docker ${action} ${preview}`,
        onClick: () => {
          const run = () =>
            c.bulkTask(`docker ${action}`, refs, (id) =>
              c.client.containerAction(action, id, options),
            );
          if (action !== "rm") {
            run();
            return;
          }
          c.askConfirm({
            title: t("Remove {count} containers?", { count: refs.length }),
            command: `docker rm -f ${names.join(" ")}`,
            confirmLabel: t("Remove"),
            tone: "danger",
            run,
          });
        },
      });

    return h(
      "div",
      {
        className:
          "flex shrink-0 items-center gap-1.5 border-b border-border bg-accent-soft/40 px-3 py-1.5 text-[11px]",
      },
      h("span", { className: "font-medium" }, t("{count} selected", { count: c.selection.size })),
      bulk("start", t("Start")),
      bulk("stop", t("Stop")),
      bulk("restart", t("Restart")),
      bulk("rm", t("Remove"), { force: true }),
      h(Button, { label: t("Clear"), size: "xs", tone: "ghost", onClick: c.clearSelection }),
    );
  };

  return { containerColumns, SelectionBar };
}
