import { Eye, FileText, Pencil, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
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
  const [mode, setMode] = useState("edit");

  useEffect(() => {
    if (open) {
      setMode("edit");
    }
  }, [open, filePath]);

  useEffect(() => {
    if (!open) {
      return undefined;
    }
    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, open]);

  const language = detectLanguage(filePath);
  const markdownFile = isMarkdownFile(filePath);
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
            <code className="rounded bg-warm px-1 py-0.5 font-mono text-[11px]" {...props}>
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4" onClick={onClose}>
      <div
        className="flex h-[86vh] w-full max-w-6xl flex-col rounded-2xl border border-border/80 bg-panel p-4 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h3 className="inline-flex items-center gap-2 truncate text-base font-semibold">
              <FileText className="h-4 w-4 text-accent" aria-hidden="true" />
              File Editor
            </h3>
            <p className="truncate text-xs text-muted">
              {filePath} {dirtyFile ? "(Unsaved)" : "(Synced)"}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className={[
                "inline-flex items-center gap-1 rounded border px-2 py-1 text-xs",
                mode === "edit"
                  ? "border-accent bg-accent text-white"
                  : "border-border bg-surface text-muted",
              ].join(" ")}
              onClick={() => setMode("edit")}
            >
              <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
              Edit
            </button>
            <button
              type="button"
              className={[
                "inline-flex items-center gap-1 rounded border px-2 py-1 text-xs",
                mode === "preview"
                  ? "border-accent bg-accent text-white"
                  : "border-border bg-surface text-muted",
              ].join(" ")}
              onClick={() => setMode("preview")}
            >
              <Eye className="h-3.5 w-3.5" aria-hidden="true" />
              Preview
            </button>
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs text-muted hover:bg-accent-soft"
              onClick={onClose}
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
              Close
            </button>
          </div>
        </div>

        {mode === "edit" ? (
          <textarea
            className="h-full w-full resize-none rounded-xl border border-border/80 bg-surface px-3 py-2 font-mono text-sm"
            value={fileContent}
            onChange={(event) => onFileContentChange(event.target.value)}
          />
        ) : markdownFile ? (
          <div className="h-full overflow-auto rounded-xl border border-border/80 bg-surface px-3 py-2 text-sm">
            <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={markdownComponents}>
              {fileContent || ""}
            </ReactMarkdown>
          </div>
        ) : (
          <div className="h-full overflow-auto rounded-xl border border-border/80 bg-surface p-2">
            <SyntaxHighlighter
              language={language}
              style={codeStyle}
              customStyle={{
                margin: 0,
                minHeight: "100%",
                borderRadius: "10px",
                border: "1px solid var(--es-border)",
                fontSize: "12px",
              }}
            >
              {fileContent || ""}
            </SyntaxHighlighter>
          </div>
        )}
      </div>
    </div>
  );
}
