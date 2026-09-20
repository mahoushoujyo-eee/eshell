// The panel's composition root: the header, the toolbar, the resource table and
// the overlays.
//
// Pure presentation over the controller's snapshot — this directory reads state
// and calls the controller's operations; it never talks to the plugin facade.
//
//   header.js    context / namespace pickers and the resource type tabs
//   toolbar.js   filter, summary, view toggles, cluster-wide reads
//   table.js     the `-o wide` table and the bulk bar
//   actions.js   the per-row menu, by resource type
//   sheets.js    logs / text / table / exec
//   modals.js    scale, apply, port-forward, settings, confirm

import { describeFailure } from "../kubectl.js";
import { createHeader } from "./header.js";
import { createModals } from "./modals.js";
import { createResourceTable } from "./table.js";
import { createRowActions } from "./actions.js";
import { createSheets } from "./sheets.js";
import { createToolbar } from "./toolbar.js";

export function createKubectlPanel({ react, ui, t }) {
  const ctx = { h: react.createElement, ui, t };
  const { h } = ctx;
  const { Button, EmptyState, NoticeBar } = ui;

  const Header = createHeader(ctx);
  const TabToolbar = createToolbar(ctx);
  const { rowActions } = createRowActions(ctx);
  const { ResourceTable, SelectionBar } = createResourceTable({ ...ctx, rowActions });
  const sheetFor = createSheets(ctx);
  const { confirmFor, modalFor } = createModals(ctx);

  const FailureView = ({ c }) => {
    const described = describeFailure(c.failure);
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
      // The raw stderr stays visible: with RBAC it names the user, the verb and
      // the resource, and that detail is the whole diagnosis.
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

  const body = (c) => {
    if (!c.hasSession) {
      return h(EmptyState, {
        title: t("No active session"),
        description: t("Open an SSH session; the panel drives kubectl on that host."),
      });
    }
    if (c.failure) {
      return h(FailureView, { c });
    }
    return h(ResourceTable, { c });
  };

  return function renderPanel({ controller }) {
    const c = controller;
    return h(
      "section",
      {
        className: "relative flex h-full min-h-0 flex-col bg-panel text-text",
        "aria-label": "Kubernetes",
      },
      h(Header, { c }),
      c.hasSession && !c.failure ? h(TabToolbar, { c }) : null,
      h(SelectionBar, { c }),
      h(NoticeBar, { notice: c.notice, onDismiss: c.dismissNotice }),
      body(c),
      sheetFor(c),
      modalFor(c),
      confirmFor(c),
    );
  };
}
