// The Compose tab: one card per project, with its services in the same table
// the Containers tab uses.
//
// `up`, `down`, `pull` and `config` need the project's compose file; `start`,
// `stop`, `restart` and `logs` work from `-p <project>` alone. A project whose
// file is unknown therefore shows the second set only.

import { describeDockerFailure } from "../docker.js";

export function createComposeTab({ h, ui, t, containerColumns }) {
  const { Button, DataTable, Dot, EmptyState, Menu, Mono, Pill } = ui;

  const projectMenu = (c, project, target, hasFiles, composeTask) => [
    { key: "stop", label: t("Stop"), hint: "compose stop", onClick: () => composeTask("stop", t("Stop")) },
    {
      key: "start",
      label: t("Start"),
      hint: "compose start",
      onClick: () => composeTask("start", t("Start")),
    },
    {
      key: "pull",
      label: t("Pull images"),
      hint: "compose pull",
      disabled: !hasFiles,
      onClick: () => composeTask("pull", t("Pull images")),
    },
    {
      key: "recreate",
      label: t("Up (force recreate)"),
      hint: "up --force-recreate",
      disabled: !hasFiles,
      onClick: () => composeTask("up", t("Up (force recreate)"), { recreate: true }),
    },
    {
      key: "config",
      label: t("Show resolved config"),
      hint: "compose config",
      disabled: !hasFiles,
      onClick: () =>
        c.openText(`${t("Config")} · ${project.name}`, "docker compose config", () =>
          c.client.composeAction("config", target),
        ),
    },
    { separator: true },
    {
      key: "down",
      label: t("Down"),
      hint: "compose down",
      tone: "danger",
      disabled: !hasFiles,
      onClick: () =>
        c.askConfirm({
          title: t("Bring this project down?"),
          body: t("Containers and the project network are removed. Named volumes are kept."),
          command: `docker compose -p ${project.name} down`,
          confirmLabel: t("Down"),
          tone: "danger",
          run: () => composeTask("down", t("Down")),
        }),
    },
    {
      key: "downv",
      label: t("Down with volumes"),
      hint: "down -v",
      tone: "danger",
      disabled: !hasFiles,
      onClick: () =>
        c.askConfirm({
          title: t("Bring this project down and delete its volumes?"),
          body: t("Named volume data is deleted and cannot be recovered."),
          command: `docker compose -p ${project.name} down -v`,
          confirmLabel: t("Down with volumes"),
          tone: "danger",
          run: () => composeTask("down", t("Down with volumes"), { volumes: true }),
        }),
    },
  ];

  const ProjectCard = ({ c, project }) => {
    const target = {
      project: project.name,
      files: project.files,
      workingDir: project.workingDir,
    };
    const hasFiles = project.files.length > 0;
    const busyKey = `compose:${project.name}`;
    const composeTask = (action, label, extra = {}) =>
      c.task(busyKey, `docker compose -p ${project.name} ${action}`, () =>
        c.client.composeAction(action, { ...target, ...extra }),
      );

    return h(
      "div",
      { className: "mb-2 overflow-hidden rounded-lg border border-border bg-surface/30" },
      h(
        "div",
        { className: "flex flex-wrap items-center gap-2 border-b border-border px-3 py-2" },
        h(Dot, { tone: project.running > 0 ? "success" : "neutral" }),
        h("span", { className: "text-xs font-semibold" }, project.name),
        h(
          Pill,
          { tone: project.running > 0 ? "success" : "neutral" },
          project.status || `${project.running}/${project.services.length} ${t("running")}`,
        ),
        hasFiles
          ? h(
              Mono,
              { className: "truncate text-muted", title: project.files.join("\n") },
              project.files[0],
            )
          : h(
              Pill,
              {
                tone: "warning",
                title: t("Without the compose file, up/down/config are unavailable."),
              },
              t("no compose file"),
            ),
        h(
          "div",
          { className: "ml-auto flex shrink-0 items-center gap-1" },
          h(Button, {
            label: t("Up"),
            size: "xs",
            tone: "primary",
            disabled: !hasFiles,
            busy: c.isBusy(busyKey),
            title: `docker compose -p ${project.name} up -d`,
            onClick: () => composeTask("up", t("Up")),
          }),
          h(Button, {
            label: t("Restart"),
            size: "xs",
            busy: c.isBusy(busyKey),
            title: `docker compose -p ${project.name} restart`,
            onClick: () => composeTask("restart", t("Restart")),
          }),
          h(Button, {
            label: t("Logs"),
            size: "xs",
            title: `docker compose -p ${project.name} logs`,
            onClick: () =>
              c.openLogs({
                kind: "compose",
                ...target,
                title: project.name,
                command: `docker compose -p ${project.name} logs --tail=${c.logTail}`,
              }),
          }),
          h(Menu, { items: projectMenu(c, project, target, hasFiles, composeTask) }),
        ),
      ),
      project.services.length === 0
        ? h(
            "p",
            { className: "px-3 py-2 text-[11px] text-muted" },
            t("No containers for this project."),
          )
        : h(DataTable, {
            columns: containerColumns(c),
            rows: project.services,
            rowKey: (container) => container.id,
            dense: true,
            empty: null,
          }),
    );
  };

  return function ComposeTab({ c }) {
    if (c.projects.length === 0) {
      return h(EmptyState, {
        title: t("No compose projects on this host."),
        description: c.composeFailure
          ? describeDockerFailure(c.composeFailure).text
          : t("A project appears here once its containers carry the compose labels docker writes."),
      });
    }
    return h(
      "div",
      { className: "min-h-0 flex-1 overflow-auto p-2" },
      c.projects.map((project) => h(ProjectCard, { key: project.name, c, project })),
    );
  };
}
