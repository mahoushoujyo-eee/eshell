// The Inspect sheet: a readable summary for a container, with the raw
// `docker inspect` JSON one click away.
//
// Images, volumes and networks have no summariser — their JSON is small and
// already readable — so those open straight into the raw view.

import { shortId } from "./format.js";

export function createInspectSheet({ h, ui, t }) {
  const { CodeBlock, CopyButton, EmptyState, KeyValue, Segmented, Sheet, useState } = ui;

  const Section = ({ title, items }) =>
    h(
      "div",
      { className: "mt-3" },
      h("p", { className: "mb-1 text-[10px] tracking-wide text-muted uppercase" }, title),
      h(
        "div",
        { className: "flex flex-col gap-0.5" },
        items.map((item, index) =>
          h("span", { key: `${item}-${index}`, className: "font-mono text-[10px] break-all" }, item),
        ),
      ),
    );

  const summaryRows = (summary) => [
    { label: t("Id"), value: shortId(summary.id), mono: true },
    { label: t("Image"), value: summary.image },
    { label: t("Image id"), value: shortId(summary.imageId), mono: true },
    {
      label: t("Status"),
      value: summary.health ? `${summary.status} (${summary.health})` : summary.status,
    },
    { label: t("Created"), value: summary.created },
    { label: t("Started"), value: summary.startedAt },
    { label: t("Finished"), value: summary.finishedAt },
    { label: t("Exit code"), value: summary.exitCode === undefined ? "" : String(summary.exitCode) },
    { label: t("Restarts"), value: summary.restartCount ? String(summary.restartCount) : "" },
    {
      label: t("Restart policy"),
      value: summary.restartPolicy === "no" ? "" : summary.restartPolicy,
    },
    { label: t("Command"), value: summary.command, mono: true },
    { label: t("Entrypoint"), value: summary.entrypoint, mono: true },
    { label: t("Working dir"), value: summary.workingDir },
    { label: t("User"), value: summary.user },
    { label: t("Log driver"), value: summary.logDriver },
    { label: t("PID"), value: summary.pid ? String(summary.pid) : "" },
  ];

  return function InspectSheet({ c }) {
    const sheet = c.sheet;
    const [view, setView] = useState("summary");
    const summary = sheet.summary;
    return h(
      Sheet,
      {
        title: `${t("Inspect")} · ${sheet.title}`,
        subtitle: sheet.subtitle,
        onClose: c.closeSheet,
        actions: [
          summary
            ? h(Segmented, {
                key: "view",
                value: view,
                onChange: setView,
                options: [
                  { value: "summary", label: t("Summary") },
                  { value: "raw", label: t("Raw JSON") },
                ],
              })
            : null,
          h(CopyButton, { key: "copy", value: sheet.raw, label: t("Copy JSON") }),
        ],
      },
      sheet.pending
        ? h(EmptyState, { title: t("Loading…") })
        : view === "raw" || !summary
          ? h(CodeBlock, { text: sheet.raw, wrap: true })
          : h(
              "div",
              { className: "min-h-0 flex-1 overflow-auto p-3" },
              h(KeyValue, { columns: 2, rows: summaryRows(summary) }),
              summary.ports.length ? h(Section, { title: t("Ports"), items: summary.ports }) : null,
              summary.networks.length
                ? h(Section, { title: t("Networks"), items: summary.networks })
                : null,
              summary.mounts.length ? h(Section, { title: t("Mounts"), items: summary.mounts }) : null,
              summary.env.length ? h(Section, { title: t("Environment"), items: summary.env }) : null,
            ),
    );
  };
}
