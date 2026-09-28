import { Eye, FileText, Pencil } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
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
import { applyEditorTab } from "../../utils/text-editor";
import Dialog, { DialogHeader } from "../ui/Dialog";
import SegmentedControl from "../ui/SegmentedControl";
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

const MARKDOWN_EXTENSIONS = new Set(["md", "markdown", "mdx"]);

const LANGUAGE_MAP = {
  yml: "yaml",
  yaml: "yaml",
  json: "json",
  toml: "toml",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  js: "javascript",
  jsx: "javascript",
  ts: "typescript",
  tsx: "typescript",
  rs: "rust",
  py: "python",
  java: "java",
  go: "go",
  html: "html",
  css: "css",
  xml: "xml",
  sql: "sql",
  ini: "ini",
  conf: "ini",
};

function getFileExtension(path) {
  const fileName = String(path || "").split("/").pop() || "";
  const chunks = fileName.split(".");
  if (chunks.length < 2) {
    return "";
  }
  return chunks[chunks.length - 1].toLowerCase();
}

function detectLanguage(path) {
  const extension = getFileExtension(path);
  return LANGUAGE_MAP[extension] || "text";
}

function isMarkdownFile(path) {
  return MARKDOWN_EXTENSIONS.has(getFileExtension(path));
}

export default function FileEditorModal({
  open,
  onClose,
  filePath,
  fileContent,
  onFileContentChange,
  dirtyFile,
  theme,
}) {
  const { t } = useI18n();
  const [mode, setMode] = useState("edit");
  const editorRef = useRef(null);

  useEffect(() => {
    if (open) {
      setMode("edit");
    }
  }, [open, filePath]);

  const language = detectLanguage(filePath);
  const markdownFile = isMarkdownFile(filePath);
  const codeStyle = theme === "dark" ? oneDark : oneLight;

  const handleEditorKeyDown = (event) => {
    if (event.key !== "Tab") {
      return;
    }

    event.preventDefault();
    const editor = event.currentTarget;
    const next = applyEditorTab(fileContent, editor.selectionStart, editor.selectionEnd);
    onFileContentChange(next.value);
    requestAnimationFrame(() => {
      editorRef.current?.setSelectionRange(next.selectionStart, next.selectionEnd);
    });
  };

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

  return (
    <Dialog
      open
      onClose={onClose}
      size="custom"
      className="h-[86vh] max-w-6xl"
      labelledBy="file-editor-title"
    >
      <DialogHeader
        icon={FileText}
        tone="accent"
        title={t("File Editor")}
        titleId="file-editor-title"
        description={
          <span className="inline-flex max-w-full items-center gap-2">
            <span className="truncate font-mono text-[11px]">{filePath}</span>
            <span className={["shrink-0 text-[11px]", dirtyFile ? "text-warning" : "text-subtle"].join(" ")}>
              {dirtyFile ? t("(Unsaved)") : t("(Synced)")}
            </span>
          </span>
        }
        actions={
          <SegmentedControl
            size="xs"
            value={mode}
            onChange={setMode}
            options={[
              { id: "edit", label: t("Edit"), icon: Pencil },
              { id: "preview", label: t("Preview"), icon: Eye },
            ]}
          />
        }
        onClose={onClose}
      />

      <div className="min-h-0 flex-1 bg-panel">
        {mode === "edit" ? (
          <textarea
            ref={editorRef}
            className="scroll-region h-full w-full resize-none bg-transparent px-4 py-3 font-mono text-[12.5px] leading-relaxed text-text outline-none"
            value={fileContent}
            onChange={(event) => onFileContentChange(event.target.value)}
            onKeyDown={handleEditorKeyDown}
            spellCheck={false}
          />
        ) : markdownFile ? (
          <div className="scroll-region h-full overflow-auto px-5 py-4 text-[13px]">
            <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={markdownComponents}>
              {fileContent || ""}
            </ReactMarkdown>
          </div>
        ) : (
          <div className="scroll-region h-full overflow-auto">
            <SyntaxHighlighter
              language={language}
              style={codeStyle}
              customStyle={{
                margin: 0,
                minHeight: "100%",
                borderRadius: 0,
                background: "transparent",
                fontSize: "12.5px",
                fontFamily: "var(--font-mono)",
              }}
              codeTagProps={{ style: { fontFamily: "var(--font-mono)" } }}
            >
              {fileContent || ""}
            </SyntaxHighlighter>
          </div>
        )}
      </div>
    </Dialog>
  );
}
