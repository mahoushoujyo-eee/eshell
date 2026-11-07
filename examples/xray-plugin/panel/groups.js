// The groups view: the balancers in the config.
//
// A group is a balancer — a tag, the tag prefixes it selects from, and the
// strategy it picks with. The row shows what it selects, how many nodes that
// is, and whether a node is currently pinned to it.

import { STRATEGY_LABELS } from "../controller/derive.js";

export function createGroups(ctx) {
  const { h, ui, t } = ctx;
  const { Button, DataTable, EmptyState, Menu, Mono, Pill, Toolbar } = ui;

  return function Groups({ c }) {
    const columns = [
      {
        key: "tag",
        label: t("Group"),
        render: (group) =>
          h(
            "div",
            { className: "flex min-w-0 items-center gap-1.5" },
            h(
              "span",
              {
                className: "truncate font-medium",
                // The rules that use this group: a balancer nothing routes to
                // is a balancer that does nothing.
                title: group.rules.length
                  ? group.rules
                      .map(
                        (rule) =>
                          `${rule.type}: ${[
                            ...rule.domain,
                            ...rule.ip,
                            rule.port ? `port ${rule.port}` : "",
                          ]
                            .filter(Boolean)
                            .join(", ")}`,
                      )
                      .join("\n")
                  : undefined,
              },
              group.tag,
            ),
            group.unused
              ? h(
                  Pill,
                  { tone: "warning", title: t("No routing rule sends traffic to this group") },
                  t("unused"),
                )
              : null,
          ),
      },
      {
        key: "members",
        label: t("Nodes"),
        width: "72px",
        align: "right",
        render: (group) => h("span", { className: "tabular-nums" }, String(group.memberCount)),
      },
      {
        key: "strategy",
        label: t("Strategy"),
        width: "120px",
        render: (group) => STRATEGY_LABELS[group.strategy] || group.strategy,
      },
      {
        key: "selector",
        label: t("Selector"),
        render: (group) =>
          h(
            Mono,
            { className: "text-muted", title: group.autoSelector.join(", ") },
            group.autoSelector.join(", ") || "—",
          ),
      },
      {
        key: "state",
        label: t("State"),
        width: "140px",
        render: (group) =>
          group.isPinned
            ? h(
                Pill,
                { tone: "info", title: group.pinnedTag },
                t("selected") + (c.names[group.pinnedTag] ? ` · ${c.names[group.pinnedTag]}` : ""),
              )
            : h(Pill, { tone: "neutral" }, t("automatic")),
      },
      {
        key: "actions",
        label: "",
        width: "96px",
        render: (group) =>
          h(Menu, {
            items: [
              {
                key: "nodes",
                label: t("Nodes…"),
                hint: String(group.memberCount),
                onClick: () => {
                  c.setSelectedGroup(group.tag);
                  c.setTab("nodes");
                },
              },
              {
                key: "edit",
                label: t("Edit…"),
                onClick: () =>
                  c.openModal("group", {
                    tag: group.tag,
                    selector: group.autoSelector.join(", "),
                    strategy: group.strategy,
                    fallbackTag: group.fallbackTag,
                  }),
              },
              { key: "sep", separator: true },
              {
                key: "delete",
                label: t("Delete…"),
                tone: "danger",
                onClick: () => c.requestDeleteGroup(group),
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
          label: t("Add group"),
          size: "xs",
          tone: "primary",
          onClick: () =>
            c.openModal("group", { tag: "", selector: "", strategy: "random", fallbackTag: "" }),
        }),
        h(
          "span",
          { className: "text-[11px] text-muted" },
          t("A group is a balancer: it picks between the nodes whose tag starts with one of its prefixes."),
        ),
      ),
      h(DataTable, {
        columns,
        rows: c.groups,
        rowKey: (group) => group.tag,
        activeKey: c.activeGroup ? c.activeGroup.tag : "",
        onRowClick: (group) => {
          c.setSelectedGroup(group.tag);
          c.setTab("nodes");
        },
        empty: h(EmptyState, {
          title: t("No groups yet"),
          description: t(
            "Add a group, then point a subscription at it — a subscription's nodes carry its prefix, and the group selects by prefix.",
          ),
        }),
      }),
    );
  };
}
