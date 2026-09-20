// The full-panel sheets and their dispatcher: logs, plain command output,
// image history and the exec console. The Inspect sheet lives next door.

import { LOG_TAIL_OPTIONS } from "../controller/index.js";
import { shortId } from "./format.js";
import { createInspectSheet } from "./sheet-inspect.js";

export function createSheets(ctx) {
  const { h, ui, t } = ctx;
  const {
    Button,
    Checkbox,
    CodeBlock,
    CopyButton,
    DataTable,
    EmptyState,
    Mono,
    Pill,
    Select,
    Sheet,
    TextInput,
    TextViewer,
    useState,
  } = ui;
  const InspectSheet = createInspectSheet(ctx);

  const LogsSheet = ({ c }) => {
    const sheet = c.sheet;
    return h(
      Sheet,
      {
        title: `${t("Logs")} · ${sheet.target.title}`,
        subtitle: sheet.target.command,
        onClose: c.closeSheet,
        actions: [
          h(TextInput, {
            key: "filter",
            value: c.logFilter,
            onChange: c.setLogFilter,
            placeholder: t("Filter lines…"),
            className: "w-36",
          }),
          h(Select, {
            key: "tail",
            value: c.logTail,
            onChange: (value) => c.setLogTail(Number(value)),
            options: LOG_TAIL_OPTIONS.map((lines) => ({ value: lines, label: `--tail ${lines}` })),
            title: "--tail",
          }),
          h(TextInput, {
            key: "since",
            value: c.logSince,
            onChange: c.setLogSince,
            placeholder: "--since 10m",
            className: "w-24",
          }),
          h(Checkbox, {
            key: "ts",
            checked: c.logTimestamps,
            onChange: c.setLogTimestamps,
            label: "-t",
            title: "--timestamps",
          }),
          h(Checkbox, { key: "wrap", checked: c.logWrap, onChange: c.setLogWrap, label: t("wrap") }),
          h(Checkbox, {
            key: "follow",
            checked: c.logFollow,
            onChange: c.setLogFollow,
            label: t("follow"),
            title: t("Re-reads every 3s. docker logs -f cannot stream over this channel."),
          }),
          h(Button, {
            key: "reload",
            label: t("Reload"),
            busy: sheet.pending,
            onClick: c.reloadLogs,
          }),
          h(CopyButton, { key: "copy", value: sheet.text, label: t("Copy") }),
        ],
      },
      h(TextViewer, { text: sheet.text, filter: c.logFilter, wrap: c.logWrap, stick: c.logFollow }),
    );
  };

  const TextSheet = ({ c }) => {
    const sheet = c.sheet;
    const [wrap, setWrap] = useState(false);
    return h(
      Sheet,
      {
        title: sheet.title,
        subtitle: sheet.subtitle,
        onClose: c.closeSheet,
        actions: [
          h(Checkbox, { key: "wrap", checked: wrap, onChange: setWrap, label: t("wrap") }),
          h(CopyButton, { key: "copy", value: sheet.text, label: t("Copy") }),
        ],
      },
      sheet.pending
        ? h(EmptyState, { title: t("Loading…") })
        : h(CodeBlock, { text: sheet.text, wrap }),
    );
  };

  const HistorySheet = ({ c }) => {
    const sheet = c.sheet;
    return h(
      Sheet,
      {
        title: `${t("History")} · ${sheet.title}`,
        subtitle: "docker image history",
        onClose: c.closeSheet,
      },
      sheet.pending
        ? h(EmptyState, { title: t("Loading…") })
        : h(DataTable, {
            columns: [
              {
                key: "id",
                label: t("Layer"),
                width: "120px",
                render: (row) => h(Mono, null, shortId(row.id)),
              },
              {
                key: "created",
                label: t("Created"),
                width: "110px",
                render: (row) => row.createdSince,
              },
              {
                key: "by",
                label: t("Created by"),
                render: (row) =>
                  h(
                    "span",
                    { title: row.createdBy, className: "font-mono text-[10px]" },
                    row.createdBy,
                  ),
              },
              {
                key: "size",
                label: t("Size"),
                width: "84px",
                align: "right",
                render: (row) => row.size,
              },
            ],
            rows: sheet.rows,
            rowKey: (row, index) => `${row.id}-${index}`,
            empty: h(EmptyState, { title: t("No layers reported.") }),
          }),
    );
  };

  /** A one-command-per-run console: `docker exec` without a TTY. */
  const ExecSheet = ({ c }) => {
    const state = c.execState;
    if (!state) {
      return null;
    }
    const entryView = (entry, index) =>
      h(
        "div",
        { key: index, className: "mb-3" },
        h(
          "div",
          { className: "flex items-center gap-2" },
          h("span", { className: "text-accent" }, "$"),
          h("span", { className: "min-w-0 flex-1 font-mono text-[11px] break-all" }, entry.line),
          h(Pill, { tone: entry.exitCode === 0 ? "success" : "danger" }, `exit ${entry.exitCode}`),
        ),
        h(
          "pre",
          {
            className:
              "mt-1 max-h-72 overflow-auto rounded-md border border-border bg-surface/40 p-2 font-mono text-[11px] whitespace-pre-wrap break-words",
          },
          entry.text,
        ),
      );

    return h(
      Sheet,
      {
        title: `${t("Exec")} · ${state.name}`,
        subtitle: t("docker exec — no TTY, one command per run."),
        onClose: c.closeSheet,
        actions: [
          h(Checkbox, {
            key: "shell",
            checked: state.shell,
            onChange: (value) => c.patchExec({ shell: value }),
            label: t("run via sh -c"),
            title: t("Off: the line is split into argv, like the CLI does."),
          }),
          h(TextInput, {
            key: "user",
            value: state.user,
            onChange: (value) => c.patchExec({ user: value }),
            placeholder: "-u root",
            className: "w-24",
          }),
          h(TextInput, {
            key: "workdir",
            value: state.workdir,
            onChange: (value) => c.patchExec({ workdir: value }),
            placeholder: "-w /app",
            className: "w-28",
          }),
        ],
        footer: h(
          "div",
          { className: "flex shrink-0 items-center gap-1.5 border-t border-border px-3 py-2" },
          h("span", { className: "shrink-0 text-accent" }, "$"),
          h(TextInput, {
            value: state.line,
            onChange: (value) => c.patchExec({ line: value }),
            onEnter: c.runExec,
            placeholder: "ls -al /",
            className: "flex-1 font-mono",
            autoFocus: true,
          }),
          h(Button, {
            label: t("Run"),
            tone: "primary",
            busy: state.running,
            disabled: !state.line.trim(),
            onClick: c.runExec,
          }),
        ),
      },
      h(
        "div",
        { className: "min-h-0 flex-1 overflow-auto p-3" },
        state.history.length === 0
          ? h(
              "p",
              { className: "text-[11px] text-muted" },
              t("Type a command below. Interactive programs will not work — there is no TTY."),
            )
          : state.history.map(entryView),
      ),
    );
  };

  const SHEETS = {
    logs: LogsSheet,
    inspect: InspectSheet,
    history: HistorySheet,
    exec: ExecSheet,
    text: TextSheet,
  };

  return function sheetFor(c) {
    if (!c.sheet) {
      return null;
    }
    const Component = SHEETS[c.sheet.kind] || TextSheet;
    return h(Component, { c });
  };
}
