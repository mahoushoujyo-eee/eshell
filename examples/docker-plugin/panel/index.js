// The panel's composition root: the header, the tab body, and the overlays.
//
// Pure presentation over the controller's snapshot — this directory reads state
// and calls the controller's operations; it never talks to the plugin facade.
//
//   rows-*.js     one table per docker object family
//   toolbar.js    the per-tab toolbar
//   tab-*.js      the two tabs that are not a plain table
//   sheets.js     logs / inspect / output / history / exec
//   modals.js     the dialogs, plus the confirmation box
//   format.js     shared formatting helpers

import { describeDockerFailure } from "../docker.js";
import { createComposeTab } from "./tab-compose.js";
import { createImageRows } from "./rows-images.js";
import { createModals } from "./modals.js";
import { createContainerRows } from "./rows-containers.js";
import { createObjectRows } from "./rows-objects.js";
import { createSheets } from "./sheets.js";
import { createSystemTab } from "./tab-system.js";
import { createToolbar } from "./toolbar.js";

export function createDockerPanel({ react, ui, t }) {
  const ctx = { h: react.createElement, ui, t };
  const { h } = ctx;
  const { Button, DataTable, EmptyState, NoticeBar, Pill, Tabs } = ui;

  const { containerColumns, SelectionBar } = createContainerRows(ctx);
  const { imageColumns } = createImageRows(ctx);
  const { eventColumns, networkColumns, volumeColumns } = createObjectRows(ctx);
  const TabToolbar = createToolbar(ctx);
  const ComposeTab = createComposeTab({ ...ctx, containerColumns });
  const SystemTab = createSystemTab(ctx);
  const sheetFor = createSheets(ctx);
  const { confirmFor, modalFor } = createModals(ctx);

  const FailureView = ({ c }) => {
    const described = describeDockerFailure(c.failure);
    return h(
      "div",
      { className: "min-h-0 flex-1 overflow-auto p-4" },
      h("p", { className: "text-xs font-medium text-danger" }, described.text),
      described.hint ? h("p", { className: "mt-1 text-[11px] text-muted" }, described.hint) : null,
      h(
        "p",
        { className: "mt-2 text-[11px] text-muted" },
        t("The panel runs {bin} on {host} over the session's SSH transport.", {
          bin: c.bin,
          host: c.hostLabel,
        }),
      ),
      // The raw stderr stays visible: the exact path in a socket permission
      // error is what distinguishes the cases.
      c.failure.detail
        ? h(
            "pre",
            {
              className:
                "mt-3 max-h-48 overflow-auto rounded-md border border-border bg-surface/50 p-2 font-mono text-[11px] whitespace-pre-wrap break-words text-muted",
            },
            c.failure.detail,
          )
        : null,
      h(
        "div",
        { className: "mt-3 flex items-center gap-1.5" },
        h(Button, { label: t("Retry"), tone: "primary", onClick: c.refresh }),
        h(Button, { label: t("Settings…"), onClick: () => c.openModal({ kind: "settings" }) }),
      ),
    );
  };

  /** One entry per table-shaped tab: its columns, rows and empty state. */
  const TABLES = {
    containers: (c) => ({
      columns: containerColumns(c),
      rows: c.containers,
      rowKey: (container) => container.id,
      selectable: true,
      selected: c.selection,
      onToggleSelect: c.toggleSelect,
      onToggleAll: (on) =>
        c.toggleSelectAll(on, c.containers.map((container) => container.id)),
      emptyTitle: t("No containers match."),
      emptyBody: t("docker ps -a returned nothing for this filter."),
    }),
    images: (c) => ({
      columns: imageColumns(c),
      rows: c.images,
      rowKey: (image) => `${image.id}:${image.reference}`,
      emptyTitle: t("No images match."),
      emptyBody: t("Pull one to get started."),
    }),
    volumes: (c) => ({
      columns: volumeColumns(c),
      rows: c.volumes,
      rowKey: (volume) => volume.name,
      emptyTitle: t("No volumes on this host."),
    }),
    networks: (c) => ({
      columns: networkColumns(c),
      rows: c.networks,
      rowKey: (network) => network.id || network.name,
      emptyTitle: t("No networks on this host."),
    }),
    events: (c) => ({
      columns: eventColumns(),
      rows: c.events,
      rowKey: (event, index) => `${event.time}-${event.id}-${index}`,
      emptyTitle: t("No events in this window."),
      emptyBody: t("Nothing happened on the daemon during the selected period."),
    }),
  };

  const body = (c) => {
    if (!c.hasSession) {
      return h(EmptyState, {
        title: t("No active session"),
        description: t("Open an SSH session; the panel drives the docker CLI on that host."),
      });
    }
    if (c.failure) {
      return h(FailureView, { c });
    }
    if (c.tab === "compose") {
      return h(ComposeTab, { c });
    }
    if (c.tab === "system") {
      return h(SystemTab, { c });
    }
    const table = (TABLES[c.tab] || TABLES.containers)(c);
    return h(DataTable, {
      ...table,
      empty: h(EmptyState, {
        title: c.loading ? t("Loading…") : table.emptyTitle,
        description: c.loading ? "" : table.emptyBody,
      }),
    });
  };

  const tabItems = (c) => [
    { id: "containers", label: t("Containers"), count: c.counts.containers, title: "docker ps -a" },
    { id: "images", label: t("Images"), count: c.counts.images, title: "docker images" },
    { id: "volumes", label: t("Volumes"), count: c.counts.volumes, title: "docker volume ls" },
    { id: "networks", label: t("Networks"), count: c.counts.networks, title: "docker network ls" },
    { id: "compose", label: t("Compose"), count: c.counts.compose, title: "docker compose ls" },
    { id: "events", label: t("Events"), count: c.counts.events, title: "docker events" },
    { id: "system", label: t("System"), title: "docker info / system df" },
  ];

  const Header = ({ c }) =>
    h(
      "div",
      { className: "flex shrink-0 items-center gap-2 border-b border-border px-3 py-2" },
      h(
        "div",
        { className: "flex min-w-0 items-center gap-1.5" },
        h("span", { className: "text-sm font-semibold" }, "Docker"),
        c.hostLabel
          ? h(Pill, { tone: "info", title: t("Active SSH session") }, c.hostLabel)
          : h(Pill, null, t("no session")),
        c.bin !== "docker" ? h(Pill, { tone: "warning", title: t("CLI prefix") }, c.bin) : null,
      ),
      h(
        "div",
        { className: "ml-auto flex min-w-0 shrink items-center gap-1.5" },
        h(Tabs, { value: c.tab, onChange: c.setTab, items: tabItems(c) }),
        h(Button, {
          label: t("Refresh"),
          size: "xs",
          busy: c.loading,
          disabled: !c.hasSession,
          title: t("Re-read the open tab"),
          onClick: c.refresh,
        }),
        h(Button, {
          label: "⚙",
          size: "xs",
          tone: "ghost",
          title: t("Panel settings"),
          onClick: () => c.openModal({ kind: "settings" }),
        }),
      ),
    );

  return function renderPanel({ controller }) {
    const c = controller;
    return h(
      "section",
      {
        className: "relative flex h-full min-h-0 flex-col bg-panel text-text",
        "aria-label": "Docker",
      },
      h(Header, { c }),
      c.hasSession && !c.failure ? h(TabToolbar, { c }) : null,
      c.tab === "containers" ? h(SelectionBar, { c }) : null,
      h(NoticeBar, { notice: c.notice, onDismiss: c.dismissNotice }),
      body(c),
      sheetFor(c),
      modalFor(c),
      confirmFor(c),
    );
  };
}
