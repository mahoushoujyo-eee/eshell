export const MARKDOWN_COMPONENTS = {
  h1: (props) => <h1 className="mb-2 text-base font-semibold" {...props} />,
  h2: (props) => <h2 className="mb-2 text-sm font-semibold" {...props} />,
  h3: (props) => <h3 className="mb-1 text-sm font-medium" {...props} />,
  p: (props) => <p className="mb-2 leading-6 last:mb-0" {...props} />,
  ul: (props) => <ul className="mb-2 list-disc pl-4 last:mb-0" {...props} />,
  ol: (props) => <ol className="mb-2 list-decimal pl-4 last:mb-0" {...props} />,
  li: (props) => <li className="mb-1" {...props} />,
  a: (props) => (
    <a
      className="text-accent underline underline-offset-2 hover:opacity-80"
      target="_blank"
      rel="noreferrer"
      {...props}
    />
  ),
  blockquote: (props) => (
    <blockquote className="my-2 border-l-2 border-border pl-3 text-muted" {...props} />
  ),
  table: (props) => (
    <div className="my-2 overflow-auto">
      <table className="w-full border-collapse text-left text-xs" {...props} />
    </div>
  ),
  th: (props) => (
    <th className="border border-border/70 bg-panel px-2 py-1 font-medium" {...props} />
  ),
  td: (props) => <td className="border border-border/70 px-2 py-1 align-top" {...props} />,
  pre: (props) => (
    <pre
      className="my-2 overflow-auto rounded-xl border border-border/80 bg-panel/95 p-2 font-mono text-[11px]"
      {...props}
    />
  ),
  code: ({ inline, className, children, ...props }) =>
    inline ? (
      <code className="rounded bg-warm px-1 py-0.5 font-mono text-[11px]" {...props}>
        {children}
      </code>
    ) : (
      <code className={["font-mono text-[11px]", className].filter(Boolean).join(" ")} {...props}>
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
