import { Eye, Pencil } from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useState, useTransition } from "react";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { PrismLight as SyntaxHighlighter } from "react-syntax-highlighter";
import bash from "react-syntax-highlighter/dist/esm/languages/prism/bash";
import css from "react-syntax-highlighter/dist/esm/languages/prism/css";
import go from "react-syntax-highlighter/dist/esm/languages/prism/go";
import ini from "react-syntax-highlighter/dist/esm/languages/prism/ini";
import java from "react-syntax-highlighter/dist/esm/languages/prism/java";
import javascript from "react-syntax-highlighter/dist/esm/languages/prism/javascript";
import json from "react-syntax-highlighter/dist/esm/languages/prism/json";
import markup from "react-syntax-highlighter/dist/esm/languages/prism/markup";
import python from "react-syntax-highlighter/dist/esm/languages/prism/python";
import rust from "react-syntax-highlighter/dist/esm/languages/prism/rust";
import sql from "react-syntax-highlighter/dist/esm/languages/prism/sql";
import toml from "react-syntax-highlighter/dist/esm/languages/prism/toml";
import typescript from "react-syntax-highlighter/dist/esm/languages/prism/typescript";
import yaml from "react-syntax-highlighter/dist/esm/languages/prism/yaml";
import { useI18n } from "../../lib/i18n";
import { detectEditorLanguage } from "../../utils/editor-language";
import Dialog, { DialogHeader } from "../ui/Dialog";
import SegmentedControl from "../ui/SegmentedControl";
import { cx } from "../ui/cx";
import UnsavedChangesDialog from "./editor/UnsavedChangesDialog";
import { oneDark, oneLight } from "react-syntax-highlighter/dist/esm/styles/prism";

SyntaxHighlighter.registerLanguage("bash", bash);
SyntaxHighlighter.registerLanguage("css", css);
SyntaxHighlighter.registerLanguage("go", go);
SyntaxHighlighter.registerLanguage("java", java);
SyntaxHighlighter.registerLanguage("javascript", javascript);
SyntaxHighlighter.registerLanguage("ini", ini);
SyntaxHighlighter.registerLanguage("json", json);
SyntaxHighlighter.registerLanguage("markup", markup);
SyntaxHighlighter.registerLanguage("python", python);
SyntaxHighlighter.registerLanguage("rust", rust);
SyntaxHighlighter.registerLanguage("sql", sql);
SyntaxHighlighter.registerLanguage("toml", toml);
SyntaxHighlighter.registerLanguage("typescript", typescript);
SyntaxHighlighter.registerLanguage("yaml", yaml);
SyntaxHighlighter.registerLanguage("html", markup);
SyntaxHighlighter.registerLanguage("xml", markup);

// Monaco is several MB; load it the first time a file is opened.
const MonacoCodeEditor = lazy(() => import("./editor/MonacoCodeEditor"));

export default function FileEditorModal({
  open,
  onClose,
  filePath,
  fileContent,
  onFileContentChange,
  dirtyFile,
  autoSync = false,
  onSave,
  onDiscard,
  theme,
}) {
  const { t } = useI18n();
  const [mode, setMode] = useState("edit");
  const [confirmingClose, setConfirmingClose] = useState(false);
  const [savingBeforeClose, startSavingBeforeClose] = useTransition();

  useEffect(() => {
    if (open) {
      setMode("edit");
      setConfirmingClose(false);
    }
  }, [open, filePath]);

  const language = detectEditorLanguage(filePath);
  const markdownFile = language === "markdown" || language === "mdx";
  const showPreview = markdownFile && mode === "preview";
  const codeStyle = theme === "dark" ? oneDark : oneLight;

  const markdownComponents = useMemo(
    () => ({
      h1: (props) => <h1 className="mb-2 text-lg font-semibold" {...props} />,
      h2: (props) => <h2 className="mb-2 text-base font-semibold" {...props} />,
      h3: (props) => <h3 className="mb-1 text-sm font-semibold" {...props} />,
      p: (props) => <p className="mb-2 leading-6 last:mb-0" {...props} />,
      ul: (props) => <ul className="mb-2 list-disc pl-4 last:mb-0" {...props} />,
      ol: (props) => <ol className="mb-2 list-decimal pl-4 last:mb-0" {...props} />,
      li: (props) => <li className="mb-1" {...props} />,
      blockquote: (props) => (
        <blockquote className="my-2 border-l-2 border-border pl-3 text-muted" {...props} />
      ),
      code: ({ inline, className, children, ...props }) => {
        const content = String(children || "").replace(/\n$/, "");
        const matched = /language-([\w-]+)/.exec(className || "");
        if (inline) {
          return (
            <code className="rounded border border-border bg-hover px-1 py-0.5 font-mono text-[11px]" {...props}>
              {children}
            </code>
          );
        }
        return (
          <SyntaxHighlighter
            language={matched?.[1] || "text"}
            style={codeStyle}
            customStyle={{
              margin: "0.5rem 0",
              borderRadius: "8px",
              border: "1px solid var(--es-border)",
              fontSize: "12px",
            }}
          >
            {content}
          </SyntaxHighlighter>
        );
      },
    }),
    [codeStyle],
  );

  if (!open || !filePath) {
    return null;
  }

  const editorLoading = (
    <div className="flex h-full items-center justify-center text-xs text-subtle">{t("Loading")}</div>
  );

  const status = !dirtyFile
    ? t("(Synced)")
    : autoSync
      ? t("(Unsaved)")
      : t("(Unsaved · Ctrl+S to save)");

  const save = () => {
    if (dirtyFile) {
      void onSave();
    }
  };

  const requestClose = () => {
    if (!dirtyFile) {
      onClose();
      return;
    }
    if (autoSync) {
      // Flush now: the debounced save is cancelled if another file opens
      // before it fires.
      void onSave();
      onClose();
      return;
    }
    setConfirmingClose(true);
  };

  const saveAndClose = () =>
    startSavingBeforeClose(async () => {
      const saved = await onSave();
      setConfirmingClose(false);
      if (saved) {
        onClose();
      }
    });

  const discardAndClose = () => {
    setConfirmingClose(false);
    onDiscard();
    onClose();
  };

  return (
    <Dialog
      open
      onClose={requestClose}
      size="custom"
      className="h-[86vh] max-w-6xl"
      labelledBy="file-editor-title"
    >
      <DialogHeader
        title={
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="truncate font-mono text-xs font-medium" title={filePath}>
              {filePath}
            </span>
            <span className={cx("shrink-0 text-[11px] font-normal", dirtyFile ? "text-warning" : "text-subtle")}>
              {status}
            </span>
          </span>
        }
        titleId="file-editor-title"
        actions={
          markdownFile ? (
            <SegmentedControl
              size="xs"
              value={mode}
              onChange={setMode}
              options={[
                { id: "edit", label: t("Edit"), icon: Pencil },
                { id: "preview", label: t("Preview"), icon: Eye },
              ]}
            />
          ) : null
        }
        onClose={requestClose}
      />

      <div className="min-h-0 flex-1 bg-panel">
        {/* Hidden rather than unmounted while previewing, so undo history and
            the cursor survive a round trip through the preview. */}
        <div className={showPreview ? "hidden" : "h-full"}>
          <Suspense fallback={editorLoading}>
            <MonacoCodeEditor
              key={filePath}
              value={fileContent}
              language={language}
              theme={theme}
              onChange={onFileContentChange}
              onSave={save}
              loading={editorLoading}
            />
          </Suspense>
        </div>
        {showPreview ? (
          <div className="scroll-region h-full overflow-auto px-5 py-4 text-[13px]">
            <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={markdownComponents}>
              {fileContent || ""}
            </ReactMarkdown>
          </div>
        ) : null}
      </div>

      <UnsavedChangesDialog
        open={confirmingClose}
        fileName={filePath.split("/").pop() || filePath}
        saving={savingBeforeClose}
        onSave={saveAndClose}
        onDiscard={discardAndClose}
        onCancel={() => setConfirmingClose(false)}
      />
    </Dialog>
  );
}
