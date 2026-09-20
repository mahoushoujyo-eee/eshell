// The full-panel sheets: logs, command text (describe / yaml / rollout output),
// a parsed table (top, events, api-resources), and the exec console.

import { LOG_TAIL_OPTIONS, SINCE_OPTIONS } from "../controller/index.js";
import { displayCell } from "../parse/status.js";
import { columnWidth } from "./format.js";

export function createSheets({ h, ui, t }) {
  const {
    Button,
    Checkbox,
    CodeBlock,
    CopyButton,
    DataTable,
    EmptyState,
    Pill,
    Select,
    Sheet,
    TextInput,
    TextViewer,
    useState,
  } = ui;

  const LogsSheet = ({ c }) => {
    const sheet = c.sheet;
    const containerOptions = [
      { value: "", label: t("all containers") },
      ...c.logContainers.map((entry) => ({
        value: entry.name,
        label: entry.init ? `${entry.name} (init)` : entry.name,
      })),
    ];
    return h(
      Sheet,
      {
        title: `${t("Logs")} · ${sheet.target.title}`,
        subtitle: sheet.target.pod
          ? `kubectl logs pod/${sheet.target.pod}`
          : `kubectl logs ${sheet.target.kind}/${sheet.target.name}`,
        onClose: c.closeSheet,
        actions: [
          h(TextInput, {
            key: "filter",
            value: c.logFilter,
            onChange: c.setLogFilter,
            placeholder: t("Filter lines…"),
            className: "w-32",
          }),
          sheet.target.pod
            ? h(Select, {
                key: "container",
                value: c.logContainer,
                onChange: c.setLogContainer,
                options: containerOptions,
                title: "-c",
                className: "max-w-32",
              })
            : null,
          h(Select, {
            key: "tail",
            value: c.logTail,
            onChange: (value) => c.setLogTail(Number(value)),
            options: LOG_TAIL_OPTIONS.map((lines) => ({ value: lines, label: `--tail=${lines}` })),
            title: "--tail",
          }),
          h(Select, {
            key: "since",
            value: c.logSince,
            onChange: c.setLogSince,
            options: SINCE_OPTIONS.map((window) => ({
              value: window,
              label: window ? `--since=${window}` : t("all time"),
            })),
            title: "--since",
          }),
          h(Checkbox, {
            key: "ts",
            checked: c.logTimestamps,
            onChange: c.setLogTimestamps,
            label: "-t",
            title: "--timestamps",
          }),
          sheet.target.pod
            ? h(Checkbox, {
                key: "prev",
                checked: c.logPrevious,
                onChange: c.setLogPrevious,
                label: t("previous"),
                title: t("--previous: the last terminated container in this pod"),
              })
            : null,
          h(Checkbox, { key: "wrap", checked: c.logWrap, onChange: c.setLogWrap, label: t("wrap") }),
          h(Checkbox, {
            key: "follow",
            checked: c.logFollow,
            onChange: c.setLogFollow,
            label: t("follow"),
            title: t("Re-reads every 3s. kubectl logs -f cannot stream over this channel."),
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

  /** `kubectl top`, events and api-resources all come back as tables. */
  const TableSheet = ({ c }) => {
    const sheet = c.sheet;
    const columns = (sheet.columns || []).map((column, index) => ({
      key: `${column}-${index}`,
      label: column,
      width: columnWidth(column, index),
      render: (row) =>
        h(
          "span",
          { className: index === 0 ? "truncate font-medium" : "truncate", title: row.byName[column] },
          displayCell(row.byName[column]),
        ),
    }));
    return h(
      Sheet,
      {
        title: sheet.title,
        subtitle: sheet.subtitle,
        onClose: c.closeSheet,
        actions: [
          h(
            CopyButton,
            {
              key: "copy",
              value: (sheet.rows || []).map((row) => row.cells.join("\t")).join("\n"),
              label: t("Copy"),
            },
          ),
        ],
      },
      sheet.pending
        ? h(EmptyState, { title: t("Loading…") })
        : h(DataTable, {
            columns,
            rows: sheet.rows || [],
            rowKey: (row) => row.key,
            dense: true,
            empty: h(EmptyState, { title: t("Nothing to show.") }),
          }),
    );
  };

  /** A one-command-per-run console: `kubectl exec` without a TTY. */
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
        title: `${t("Exec")} · ${state.pod}`,
        subtitle: t("kubectl exec — no TTY, one command per run."),
        onClose: c.closeSheet,
        actions: [
          state.containers.length > 1
            ? h(Select, {
                key: "container",
                value: state.container,
                onChange: (value) => c.patchExec({ container: value }),
                options: [
                  { value: "", label: t("(first container)") },
                  ...state.containers.map((entry) => ({ value: entry.name, label: entry.name })),
                ],
                title: "-c",
                className: "max-w-32",
              })
            : null,
          h(Checkbox, {
            key: "shell",
            checked: state.shell,
            onChange: (value) => c.patchExec({ shell: value }),
            label: t("run via sh -c"),
            title: t("Off: the line is split into argv, like the CLI does after --."),
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
            placeholder: "cat /etc/hosts",
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

  const SHEETS = { logs: LogsSheet, table: TableSheet, exec: ExecSheet, text: TextSheet };

  return function sheetFor(c) {
    if (!c.sheet) {
      return null;
    }
    const Component = SHEETS[c.sheet.kind] || TextSheet;
    return h(Component, { c });
  };
}
