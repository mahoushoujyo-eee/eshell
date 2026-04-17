export const MARKDOWN_COMPONENTS = {
  h1: (props) => <h1 {...props} />,
  h2: (props) => <h2 {...props} />,
  h3: (props) => <h3 {...props} />,
  p: (props) => <p {...props} />,
  ul: (props) => <ul {...props} />,
  ol: (props) => <ol {...props} />,
  li: (props) => <li {...props} />,
  a: (props) => (
    <a
      className="ai-markdown-link"
      target="_blank"
      rel="noreferrer"
      {...props}
    />
  ),
  blockquote: (props) => <blockquote {...props} />,
  table: (props) => (
    <div className="ai-markdown-table-wrap">
      <table {...props} />
    </div>
  ),
  th: (props) => <th {...props} />,
  td: (props) => <td {...props} />,
  pre: (props) => <pre className="ai-markdown-pre" {...props} />,
  code: ({ className, children, ...props }) => (
    <code
      className={[
        "ai-markdown-inline-code",
        className || "",
      ].join(" ").trim()}
      {...props}
    >
      {children}
    </code>
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
  if (toolState === "failed") {
    return "failed";
  }
  if (toolState === "rejected") {
    return "rejected";
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
  if (toolState === "failed") {
    return "border-danger/45 bg-danger/12 text-danger";
  }
  if (toolState === "rejected") {
    return "border-border/75 bg-surface/70 text-muted";
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
