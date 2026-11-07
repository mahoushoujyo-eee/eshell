// The panel's composition root: the header, the tab bar, the four views and
// the overlays.
//
// Pure presentation over the controller's snapshot — this directory reads
// state and calls the controller's operations; it never talks to the plugin
// facade.
//
//   header.js        what the host has, and the tab bar
//   overview.js      the counts and the capabilities
//   groups.js        the balancers, and what a group selects
//   subscriptions.js the sources the nodes come from
//   nodes.js         the nodes of the selected group
//   modals.js        the group / subscription / settings forms, and the confirm

import { describeFailure } from "../failures.js";
import { createGroups } from "./groups.js";
import { createHeader } from "./header.js";
import { createModals } from "./modals.js";
import { createNodes } from "./nodes.js";
import { createOverview } from "./overview.js";
import { createSubscriptions } from "./subscriptions.js";

export function createXrayPanel({ react, ui, t }) {
  const ctx = { h: react.createElement, ui, t };
  const { h } = ctx;
  const { Button, EmptyState, NoticeBar } = ui;

  const Header = createHeader(ctx);
  const Overview = createOverview(ctx);
  const Groups = createGroups(ctx);
  const Subscriptions = createSubscriptions(ctx);
  const Nodes = createNodes(ctx);
  const { modalFor, confirmFor } = createModals(ctx);

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
        t("The panel runs xray on {host} over the session's SSH transport.", {
          host: c.hostLabel,
        }),
      ),
      // The raw output stays visible: xray's own message names the field it
      // could not parse, and that detail is the whole diagnosis.
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
        h(Button, { label: t("Settings…"), onClick: c.openSettings }),
      ),
    );
  };

  const body = (c) => {
    if (!c.hasSession) {
      return h(EmptyState, {
        title: t("No active session"),
        description: t("Open an SSH session; the panel manages xray on that host."),
      });
    }
    if (c.failure) {
      return h(FailureView, { c });
    }
    switch (c.tab) {
      case "overview":
        return h(Overview, { c });
      case "groups":
        return h(Groups, { c });
      case "subscriptions":
        return h(Subscriptions, { c });
      case "nodes":
        return h(Nodes, { c });
      default:
        return h(Overview, { c });
    }
  };

  return function renderPanel({ controller }) {
    const c = controller;
    return h(
      "section",
      {
        className: "relative flex h-full min-h-0 flex-col bg-panel text-text",
        "aria-label": "Xray Proxy",
      },
      h(Header, { c }),
      h(NoticeBar, { notice: c.notice, onDismiss: c.dismissNotice }),
      // The body takes the rest of the panel. Without this wrapper the empty
      // state — which is `h-full` — would be as tall as the whole panel and
      // centre its text below the visible area.
      h("div", { className: "flex min-h-0 flex-1 flex-col" }, body(c)),
      modalFor(c),
      confirmFor(c),
    );
  };
}
