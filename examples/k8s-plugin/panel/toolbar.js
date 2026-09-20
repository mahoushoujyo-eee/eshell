// The toolbar: the filter, the health summary, the view toggles, and the
// cluster-wide reads that do not belong to a single row.

import { AUTO_REFRESH_OPTIONS } from "../controller/index.js";

export function createToolbar({ h, ui, t }) {
  const { Button, Checkbox, Menu, Pill, Select, Spacer, TextInput, Toolbar } = ui;

  const Summary = ({ c }) => {
    const { total, success, warning, danger } = c.summary;
    if (total === 0) {
      return null;
    }
    return h(
      "div",
      { className: "flex shrink-0 items-center gap-1" },
      h(Pill, { title: t("Rows in this listing") }, String(total)),
      success ? h(Pill, { tone: "success", title: t("Healthy") }, String(success)) : null,
      warning ? h(Pill, { tone: "warning", title: t("Pending or changing") }, String(warning)) : null,
      danger ? h(Pill, { tone: "danger", title: t("Failing") }, String(danger)) : null,
    );
  };

  const clusterMenu = (c) => [
    {
      key: "topNodes",
      label: t("Top nodes"),
      hint: "kubectl top nodes",
      onClick: () =>
        c.openTable(t("Top nodes"), "kubectl top nodes", () => c.client.top("nodes")),
    },
    {
      key: "topPods",
      label: t("Top pods"),
      hint: "kubectl top pods",
      onClick: () =>
        c.openTable(t("Top pods"), "kubectl top pods --containers", () =>
          c.client.top("pods", { containers: true }),
        ),
    },
    {
      key: "events",
      label: t("Namespace events"),
      hint: "kubectl get events",
      onClick: () =>
        c.openTable(t("Events"), "kubectl get events --sort-by=.lastTimestamp", () =>
          c.client.events(),
        ),
    },
    { separator: true },
    {
      key: "clusterInfo",
      label: t("Cluster info"),
      hint: "kubectl cluster-info",
      onClick: () => c.openText(t("Cluster info"), "kubectl cluster-info", () => c.client.clusterInfo()),
    },
    {
      key: "apiResources",
      label: t("API resources"),
      hint: "kubectl api-resources",
      onClick: () =>
        c.openTable(t("API resources"), "kubectl api-resources -o wide", () =>
          c.client.apiResources(),
        ),
    },
    {
      key: "explain",
      label: t("Explain this type"),
      hint: "kubectl explain",
      onClick: () =>
        c.openText(
          `${t("Explain")} · ${c.descriptor.kind}`,
          `kubectl explain ${c.descriptor.kind} --recursive`,
          () => c.client.explain(c.descriptor.kind),
        ),
    },
  ];

  return function TabToolbar({ c }) {
    return h(
      Toolbar,
      null,
      h(TextInput, {
        value: c.query,
        onChange: c.setQuery,
        placeholder: t("Filter rows…"),
        className: "w-44",
        ariaLabel: t("Filter rows"),
      }),
      h(Checkbox, {
        checked: c.onlyProblems,
        onChange: c.setOnlyProblems,
        label: t("problems only"),
        title: t("Rows whose status is not healthy"),
      }),
      h(Summary, { c }),
      h(Spacer),
      h(Checkbox, {
        checked: c.sortByAge,
        onChange: c.setSortByAge,
        label: t("by age"),
        title: "--sort-by=.metadata.creationTimestamp",
      }),
      h(Checkbox, {
        checked: !c.hideNoisy,
        onChange: (value) => c.setHideNoisy(!value),
        label: t("all columns"),
        title: t("Show the -o wide columns that are almost always empty"),
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
      h(Menu, { label: t("Cluster…"), size: "sm", tone: "default", items: clusterMenu(c) }),
      h(Button, {
        label: t("Apply YAML…"),
        tone: "primary",
        title: "kubectl apply -f -",
        onClick: () => c.openModal({ kind: "apply" }),
      }),
    );
  };
}
