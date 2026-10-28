// The nodes view: the nodes the selected group picks between.
//
// Selecting a node narrows the group's selector to that one outbound and
// restarts xray, so it goes through a confirmation that says exactly what
// changes — the same rule the other panels apply to anything that interrupts
// a running service.

import { formatDelay } from "../parse/observatory.js";

export function createNodes(ctx) {
  const { h, ui, t } = ctx;
  const { Button, DataTable, EmptyState, Menu, Mono, Pill, Select, TextInput, Toolbar } = ui;

  const requestSelect = (c, group, node) => {
    c.openConfirm({
      title: t("Select this node"),
      description: t(
        "The group's selector is narrowed to this node and xray is restarted. Traffic through this group moves to it.",
      ),
      command: `${group.tag} → ${node.tag}`,
      confirmLabel: t("Select"),
      tone: "primary",
      run: () => c.selectNode(group, node),
    });
  };

  return function Nodes({ c }) {
    const group = c.activeGroup;

    const columns = [
      {
        key: "node",
        label: t("Node"),
        render: (node) =>
          h(
            "div",
            { className: "flex min-w-0 flex-col" },
            h("span", { className: "truncate font-medium" }, node.name),
            h(Mono, { className: "text-[10px] text-muted" }, node.tag),
          ),
      },
      {
        key: "protocol",
        label: t("Protocol"),
        width: "110px",
        render: (node) => h(Pill, { tone: "neutral" }, node.protocol || "—"),
      },
      {
        key: "address",
        label: t("Address"),
        render: (node) =>
          h(
            Mono,
            { className: "text-muted", title: node.address },
            node.address ? `${node.address}${node.port ? `:${node.port}` : ""}` : "—",
          ),
      },
      {
        key: "network",
        label: t("Transport"),
        width: "110px",
        render: (node) =>
          h(
            "span",
            { className: "text-muted" },
            node.network + (node.security && node.security !== "none" ? ` · ${node.security}` : ""),
          ),
      },
      {
        key: "delay",
        label: t("Delay"),
        width: "90px",
        align: "right",
        render: (node) =>
          h(
            "span",
            { className: "tabular-nums text-muted" },
            formatDelay(c.delays[node.tag]),
          ),
      },
      {
        key: "state",
        label: t("State"),
        width: "96px",
        render: (node) =>
          group && group.pinnedTag === node.tag
            ? h(Pill, { tone: "info" }, t("selected"))
            : h(Pill, { tone: "neutral" }, t("standby")),
      },
      {
        key: "actions",
        label: "",
        width: "96px",
        render: (node) =>
          h(Menu, {
            items: [
              {
                key: "select",
                label: t("Select…"),
                disabled: !group || group.pinnedTag === node.tag,
                onClick: () => requestSelect(c, group, node),
              },
              {
                key: "auto",
                label: t("Automatic"),
                disabled: !group || !group.isPinned,
                onClick: () => c.restoreAuto(group),
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
        h(
          Select,
          {
            value: group ? group.tag : "",
            title: t("Group"),
            ariaLabel: t("Group"),
            onChange: (value) => c.setSelectedGroup(value),
            options: c.groups.map((entry) => ({ value: entry.tag, label: entry.tag })),
          },
        ),
        h(TextInput, {
          value: c.query,
          onChange: c.setQuery,
          placeholder: t("Filter the nodes"),
          ariaLabel: t("Filter the nodes"),
          className: "w-40",
        }),
        group && group.isPinned
          ? h(Button, {
              label: t("Automatic"),
              size: "xs",
              busy: c.isBusy("auto"),
              onClick: () => c.restoreAuto(group),
              title: t("Hand the group back to its strategy"),
            })
          : null,
        h(
          "span",
          { className: "text-[11px] text-muted" },
          group
            ? t("{n} nodes · {strategy}", {
                n: group.memberCount,
                strategy: group.strategy,
              })
            : t("No group selected"),
        ),
      ),
      h(DataTable, {
        columns,
        rows: c.activeNodes,
        rowKey: (node) => node.tag,
        activeKey: group ? group.pinnedTag : "",
        onRowClick: (node) => requestSelect(c, group, node),
        empty: h(EmptyState, {
          title: group ? t("This group selects no nodes") : t("No group selected"),
          description: t(
            "A group selects the outbounds whose tag starts with one of its prefixes. Update the subscription that feeds this prefix, or widen the selector.",
          ),
        }),
      }),
    );
  };
}
