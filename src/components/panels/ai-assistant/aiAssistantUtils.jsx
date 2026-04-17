import { Check, Code2, Copy } from "lucide-react";
import { useEffect, useState } from "react";
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

const LANGUAGE_LABELS = {
  js: "JavaScript",
  jsx: "JavaScript",
  ts: "TypeScript",
  tsx: "TypeScript",
  py: "Python",
  sh: "Shell",
  bash: "Bash",
  zsh: "Zsh",
  yml: "YAML",
  yaml: "YAML",
  rs: "Rust",
  html: "HTML",
  xml: "XML",
  css: "CSS",
  json: "JSON",
  sql: "SQL",
  ini: "INI",
  toml: "TOML",
};

const LANGUAGE_ALIASES = {
  js: "javascript",
  jsx: "javascript",
  ts: "typescript",
  tsx: "typescript",
  py: "python",
  sh: "bash",
  zsh: "bash",
  yml: "yaml",
  html: "html",
  xml: "xml",
};

function normalizeCodeLanguage(language) {
  const normalized = String(language || "")
    .trim()
    .toLowerCase();
  if (!normalized) {
    return "text";
  }
  return LANGUAGE_ALIASES[normalized] || normalized;
}

function languageDisplayName(language) {
  const normalized = String(language || "")
    .trim()
    .toLowerCase();
  if (!normalized) {
    return "Code";
  }
  if (LANGUAGE_LABELS[normalized]) {
    return LANGUAGE_LABELS[normalized];
  }
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function useDocumentTheme() {
  const readTheme = () =>
    typeof document === "undefined"
      ? "light"
      : document.documentElement.getAttribute("data-theme") || "light";
  const [theme, setTheme] = useState(readTheme);

  useEffect(() => {
    if (typeof document === "undefined") {
      return undefined;
    }

    const root = document.documentElement;
    const observer = new MutationObserver(() => {
      setTheme(root.getAttribute("data-theme") || "light");
    });

    observer.observe(root, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });

    return () => observer.disconnect();
  }, []);

  return theme;
}

function MarkdownCodeBlock({ className, children }) {
  const theme = useDocumentTheme();
  const [copied, setCopied] = useState(false);
  const rawLanguage = /language-([\w-]+)/.exec(className || "")?.[1] || "";
  const language = normalizeCodeLanguage(rawLanguage);
  const codeStyle = theme === "dark" ? oneDark : oneLight;
  const content = String(children || "").replace(/\n$/, "");

  useEffect(() => {
    if (!copied) {
      return undefined;
    }
    const timer = window.setTimeout(() => setCopied(false), 1400);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const handleCopy = async () => {
    const hasSelection = typeof window !== "undefined" && String(window.getSelection?.() || "").trim();
    if (hasSelection) {
      return;
    }

    const ok = await copyText(content);
    if (ok) {
      setCopied(true);
    }
  };

  return (
    <div
      className="group my-3 overflow-hidden rounded-[26px] border border-border/60 bg-[linear-gradient(180deg,rgba(255,255,255,0.88),rgba(250,248,243,0.92))] shadow-[0_1px_0_rgba(255,255,255,0.8),0_10px_30px_rgba(67,58,43,0.05)]"
      onClick={() => {
        void handleCopy();
      }}
      title="Click code block to copy"
    >
      <div className="flex items-center justify-between gap-3 border-b border-border/45 px-5 py-3">
        <div className="inline-flex min-w-0 items-center gap-2 text-[13px] font-medium text-text">
          <Code2 className="h-4 w-4 shrink-0 text-muted" aria-hidden="true" />
          <span className="truncate">{languageDisplayName(rawLanguage)}</span>
        </div>

        <button
          type="button"
          className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-transparent text-muted transition-all hover:border-border/60 hover:bg-white/80 hover:text-text"
          onClick={(event) => {
            event.stopPropagation();
            void handleCopy();
          }}
          title={copied ? "Copied" : "Copy code"}
          aria-label={copied ? "Copied" : "Copy code"}
        >
          {copied ? <Check className="h-4 w-4 text-accent" /> : <Copy className="h-4 w-4" />}
        </button>
      </div>

      <SyntaxHighlighter
        language={language}
        style={codeStyle}
        PreTag="div"
        customStyle={{
          margin: 0,
          background: "transparent",
          padding: "1rem 1.5rem 1.35rem",
          border: "none",
          borderRadius: 0,
          fontSize: "13px",
          lineHeight: "1.7",
        }}
        codeTagProps={{
          style: {
            fontFamily:
              '"IBM Plex Mono","SFMono-Regular","Cascadia Code","Fira Code","Consolas","Courier New",monospace',
          },
        }}
      >
        {content}
      </SyntaxHighlighter>
    </div>
  );
}

export const MARKDOWN_COMPONENTS = {
  h1: (props) => <h1 className="mb-2 text-base font-semibold" {...props} />,
  h2: (props) => <h2 className="mb-2 text-sm font-semibold" {...props} />,
  h3: (props) => <h3 className="mb-1 text-sm font-medium" {...props} />,
  p: (props) => <p className="mb-2 break-words leading-6 [overflow-wrap:anywhere] last:mb-0" {...props} />,
  ul: (props) => <ul className="mb-2 list-disc break-words pl-4 [overflow-wrap:anywhere] last:mb-0" {...props} />,
  ol: (props) => <ol className="mb-2 list-decimal break-words pl-4 [overflow-wrap:anywhere] last:mb-0" {...props} />,
  li: (props) => <li className="mb-1 break-words [overflow-wrap:anywhere]" {...props} />,
  a: (props) => (
    <a
      className="break-all text-accent underline underline-offset-2 [overflow-wrap:anywhere] hover:opacity-80"
      target="_blank"
      rel="noreferrer"
      {...props}
    />
  ),
  blockquote: (props) => (
    <blockquote className="my-2 border-l-2 border-border pl-3 break-words text-muted [overflow-wrap:anywhere]" {...props} />
  ),
  table: (props) => (
    <div className="my-2 overflow-auto">
      <table className="w-full border-collapse text-left text-xs" {...props} />
    </div>
  ),
  th: (props) => (
    <th className="border border-border/70 bg-panel px-2 py-1 break-words font-medium [overflow-wrap:anywhere]" {...props} />
  ),
  td: (props) => <td className="border border-border/70 px-2 py-1 align-top break-words [overflow-wrap:anywhere]" {...props} />,
  pre: ({ children }) => children,
  code: ({ inline, className, children, ...props }) =>
    inline ? (
      <code
        className="rounded bg-warm px-1 py-0.5 font-mono text-[11px] break-all whitespace-pre-wrap [overflow-wrap:anywhere]"
        {...props}
      >
        {children}
      </code>
    ) : (
      <MarkdownCodeBlock className={className}>{children}</MarkdownCodeBlock>
    ),
};

export const actionButtonClass =
  "inline-flex h-9 w-9 items-center justify-center rounded-xl border border-border/75 bg-surface/75 text-muted transition-colors hover:border-accent/45 hover:bg-accent-soft hover:text-text";

export const messageActionButtonClass =
  "inline-flex items-center gap-1.5 rounded-xl border border-border/75 bg-surface/70 px-2.5 py-1.5 text-[11px] font-medium text-muted transition-colors hover:border-accent/45 hover:bg-accent-soft hover:text-text";

export const copyText = async (value) => {
  const text = String(value || "");
  if (!text) {
    return false;
  }

  if (navigator?.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return true;
  }

  const textArea = document.createElement("textarea");
  textArea.value = text;
  textArea.setAttribute("readonly", "");
  textArea.style.position = "fixed";
  textArea.style.opacity = "0";
  document.body.appendChild(textArea);
  textArea.select();
  const copied = document.execCommand("copy");
  document.body.removeChild(textArea);
  return copied;
};

export const formatTime = (value) => {
  if (!value) {
    return "";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
};

export const formatTurnTime = (messages) => {
  if (!Array.isArray(messages) || messages.length === 0) {
    return "";
  }

  const firstTime = formatTime(messages[0]?.createdAt);
  const lastTime = formatTime(messages[messages.length - 1]?.createdAt);

  if (!firstTime) {
    return lastTime;
  }
  if (!lastTime || lastTime === firstTime) {
    return firstTime;
  }
  return `${firstTime} - ${lastTime}`;
};

export const roleLabel = (role) => {
  if (role === "user") {
    return "You";
  }
  if (role === "tool") {
    return "Tool";
  }
  return "Agent";
};

export const toolLabel = (toolKind) => {
  if (typeof toolKind !== "string" || !toolKind.trim()) {
    return "tool";
  }
  return toolKind.trim();
};

export const toolStateLabel = (toolState) => {
  if (toolState === "awaiting_approval") {
    return "awaiting approval";
  }
  if (toolState === "executed") {
    return "executed";
  }
  if (toolState === "requested") {
    return "requested";
  }
  return "";
};

export const toolStateBadgeClass = (toolState) => {
  if (toolState === "awaiting_approval") {
    return "border-[#e1b95d] bg-[#ffecc3] text-[#8a5a00]";
  }
  if (toolState === "executed") {
    return "border-success/45 bg-success/10 text-success";
  }
  if (toolState === "requested") {
    return "border-border/75 bg-surface/70 text-muted";
  }
  return "border-border/75 bg-surface/70 text-muted";
};

export const pendingRiskLabel = (riskLevel) => {
  if (typeof riskLevel !== "string" || !riskLevel.trim()) {
    return "unknown";
  }
  return riskLevel.trim().toLowerCase();
};

export const pendingRiskBadgeClass = (riskLevel) => {
  if (riskLevel === "high") {
    return "border-danger/45 bg-danger/15 text-danger";
  }
  if (riskLevel === "medium") {
    return "border-[#e1b95d] bg-[#ffecc3] text-[#8a5a00]";
  }
  if (riskLevel === "low") {
    return "border-success/45 bg-success/10 text-success";
  }
  return "border-border/75 bg-surface/70 text-muted";
};
