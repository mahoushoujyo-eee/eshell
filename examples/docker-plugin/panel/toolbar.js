// The per-tab toolbar: the filter box plus whatever that tab can do.

import { AUTO_REFRESH_OPTIONS, EVENT_WINDOWS } from "../controller/index.js";

export function createToolbar({ h, ui, t }) {
  const { Button, Checkbox, Segmented, Select, Spacer, TextInput, Toolbar } = ui;

  const search = (c) =>
    h(TextInput, {
      key: "search",
      value: c.query,
      onChange: c.setQuery,
      placeholder: t("Filter…"),
      className: "w-44",
      ariaLabel: t("Filter"),
    });

  const pruneButton = (c, { title, command, body, run }) =>
    h(Button, {
      label: t("Prune"),
      tone: "danger",
      title: command,
      onClick: () =>
        c.askConfirm({ title, body, command, confirmLabel: t("Prune"), tone: "danger", run }),
    });

  const TABS = {
    containers: (c) =>
      h(
        Toolbar,
        null,
        search(c),
        h(Segmented, {
          value: c.stateFilter,
          onChange: c.setStateFilter,
          options: [
            { value: "all", label: t("All"), title: "docker ps -a" },
            { value: "running", label: t("Running"), title: "docker ps" },
            { value: "stopped", label: t("Stopped") },
            { value: "paused", label: t("Paused") },
          ],
        }),
        h(Spacer),
        h(Checkbox, {
          checked: c.statsEnabled,
          onChange: c.setStatsEnabled,
          label: t("stats"),
          title: "docker stats --no-stream",
        }),
        h(Select, {
          value: c.autoRefresh,
          onChange: (value) => c.setAutoRefresh(Number(value)),
          title: t("Auto refresh"),
          options: AUTO_REFRESH_OPTIONS.map((seconds) => ({
            value: seconds,
            label: seconds === 0 ? t("no auto refresh") : `${seconds}s`,
          })),
        }),
        h(Button, {
          label: t("Run container…"),
          tone: "primary",
          title: "docker run",
          onClick: () => c.openModal({ kind: "run" }),
        }),
      ),

    images: (c) =>
      h(
        Toolbar,
        null,
        search(c),
        h(Checkbox, {
          checked: c.imagesAll,
          onChange: c.setImagesAll,
          label: t("intermediate"),
          title: "docker images -a",
        }),
        h(Checkbox, {
          checked: c.imagesDangling,
          onChange: c.setImagesDangling,
          label: t("dangling only"),
          title: "--filter dangling=true",
        }),
        h(Spacer),
        h(Button, {
          label: t("Search Hub…"),
          title: "docker search",
          onClick: () => c.openModal({ kind: "search" }),
        }),
        h(Button, {
          label: t("Pull…"),
          tone: "primary",
          title: "docker pull",
          onClick: () => c.openModal({ kind: "pull" }),
        }),
      ),

    volumes: (c) =>
      h(
        Toolbar,
        null,
        search(c),
        h(Spacer),
        pruneButton(c, {
          title: t("Remove unused volumes"),
          body: t("Volume data is deleted and cannot be recovered."),
          command: "docker volume prune -f",
          run: () => c.task("prune", t("Remove unused volumes"), () => c.client.pruneVolumes()),
        }),
        h(Button, {
          label: t("Create…"),
          tone: "primary",
          title: "docker volume create",
          onClick: () => c.openModal({ kind: "createVolume" }),
        }),
      ),

    networks: (c) =>
      h(
        Toolbar,
        null,
        search(c),
        h(Spacer),
        pruneButton(c, {
          title: t("Remove unused networks"),
          command: "docker network prune -f",
          run: () => c.task("prune", t("Remove unused networks"), () => c.client.pruneNetworks()),
        }),
        h(Button, {
          label: t("Create…"),
          tone: "primary",
          title: "docker network create",
          onClick: () => c.openModal({ kind: "createNetwork" }),
        }),
      ),

    events: (c) =>
      h(
        Toolbar,
        null,
        search(c),
        h(Select, {
          value: c.eventWindow,
          onChange: c.setEventWindow,
          options: EVENT_WINDOWS.map((window) => ({ value: window, label: `--since ${window}` })),
          title: "docker events --since",
        }),
        h(Spacer),
        h(
          "span",
          { className: "text-[10px] text-muted" },
          t("A bounded window: an open event stream cannot be interrupted here."),
        ),
      ),

    compose: (c) =>
      h(
        Toolbar,
        null,
        search(c),
        h(Spacer),
        h(
          "span",
          { className: "text-[10px] text-muted" },
          t("Projects are grouped by the compose labels docker wrote on each container."),
        ),
      ),
  };

  return function TabToolbar({ c }) {
    const build = TABS[c.tab];
    return build ? build(c) : null;
  };
}
