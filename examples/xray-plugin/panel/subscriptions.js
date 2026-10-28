// The subscriptions view: the sources the nodes come from.
//
// A subscription is a URL. The host downloads it, the panel reads it, and
// the nodes it carries replace the ones the subscription owned before. The
// URL is a secret — it carries the token that identifies the account — so it
// is shown masked, and the row says when the config holds fewer nodes than
// the provider last served.

import { maskUrl } from "../controller/derive.js";
import { formatAgo, formatTime } from "./format.js";

export function createSubscriptions(ctx) {
  const { h, ui, t } = ctx;
  const { Button, DataTable, EmptyState, Menu, Mono, Pill, Toolbar } = ui;

  return function Subscriptions({ c }) {
    const columns = [
      {
        key: "name",
        label: t("Subscription"),
        render: (subscription) =>
          h(
            "div",
            { className: "flex min-w-0 items-center gap-1.5" },
            h("span", { className: "truncate font-medium" }, subscription.name || "—"),
            subscription.outdated
              ? h(
                  Pill,
                  { tone: "warning", title: t("The config holds a different number of nodes") },
                  t("changed"),
                )
              : null,
          ),
      },
      {
        key: "url",
        label: t("URL"),
        // The URL carries the account token, so the list shows only the host
        // and the tail of the path. The full link is in the edit form.
        render: (subscription) =>
          h(Mono, { className: "text-muted" }, maskUrl(subscription.url)),
      },
      {
        key: "prefix",
        label: t("Prefix"),
        width: "120px",
        render: (subscription) => h(Mono, { className: "text-muted" }, subscription.prefix),
      },
      {
        key: "nodes",
        label: t("Nodes"),
        width: "72px",
        align: "right",
        render: (subscription) =>
          h(
            "span",
            { className: "tabular-nums" },
            `${subscription.configuredCount}/${subscription.nodeCount || 0}`,
          ),
      },
      {
        key: "updated",
        label: t("Updated"),
        width: "140px",
        render: (subscription) =>
          h(
            "div",
            { className: "flex flex-col" },
            h("span", null, formatAgo(subscription.updatedAt, t)),
            h("span", { className: "text-[10px] text-muted" }, formatTime(subscription.updatedAt)),
          ),
      },
      {
        key: "actions",
        label: "",
        width: "96px",
        render: (subscription) =>
          h(Menu, {
            items: [
              {
                key: "update",
                label: t("Update"),
                disabled: c.isBusy(`sub:${subscription.id}`),
                onClick: () => c.task(`sub:${subscription.id}`, t("Update") + " " + subscription.name, () => c.updateSubscription(subscription)),
              },
              {
                key: "edit",
                label: t("Edit…"),
                onClick: () =>
                  c.openModal("subscription", {
                    id: subscription.id,
                    name: subscription.name,
                    url: subscription.url,
                    prefix: subscription.prefix,
                  }),
              },
              { key: "sep", separator: true },
              {
                key: "delete",
                label: t("Delete…"),
                tone: "danger",
                onClick: () => c.requestDeleteSubscription(subscription),
              },
            ],
          }),
      },
    ];

    return h(
      "div",
      { className: "flex min-h-0 flex-1 flex-col" },
      h(
        Toolbar,
        {},
        h(Button, {
          label: t("Add subscription"),
          size: "xs",
          tone: "primary",
          onClick: () => c.openModal("subscription", { name: "", url: "", prefix: "" }),
        }),
        h(
          "span",
          { className: "text-[11px] text-muted" },
          t("The subscription is downloaded by the host, not by this machine."),
        ),
      ),
      h(DataTable, {
        columns,
        rows: c.subscriptions,
        rowKey: (subscription) => subscription.id,
        empty: h(EmptyState, {
          title: t("No subscriptions"),
          description: t(
            "Add a subscription link. Its nodes are written into the config under the prefix you choose.",
          ),
        }),
      }),
    );
  };
}
