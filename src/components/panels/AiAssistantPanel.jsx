import { Bot, Send, Terminal } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

const MARKDOWN_COMPONENTS = {
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
  th: (props) => <th className="border border-border/70 bg-panel px-2 py-1 font-medium" {...props} />,
  td: (props) => <td className="border border-border/70 px-2 py-1 align-top" {...props} />,
  pre: (props) => (
    <pre
      className="my-2 overflow-auto rounded-md border border-border/80 bg-panel p-2 font-mono text-[11px]"
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

export default function AiAssistantPanel({
  aiAnswer,
  onWriteSuggestedCommand,
  aiQuestion,
  setAiQuestion,
  aiIncludeOutput,
  setAiIncludeOutput,
  onAskAi,
}) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-panel">
      <div className="flex items-center justify-between border-b border-border px-2 py-2">
        <div className="inline-flex items-center gap-2 text-sm font-semibold">
          <Bot className="h-4 w-4 text-accent" aria-hidden="true" />
          AI Assistant
        </div>
        {aiAnswer?.suggestedCommand && (
          <button
            type="button"
            className="inline-flex items-center gap-1.5 border border-accent bg-accent px-2 py-1 text-xs text-white"
            onClick={onWriteSuggestedCommand}
          >
            <Terminal className="h-3.5 w-3.5" aria-hidden="true" />
            Insert Command
          </button>
        )}
      </div>

      <form className="shrink-0 space-y-2 border-b border-border px-2 py-2" onSubmit={onAskAi}>
        <textarea
          className="h-16 w-full border border-border bg-surface px-2 py-1.5 text-sm"
          value={aiQuestion}
          onChange={(event) => setAiQuestion(event.target.value)}
          placeholder="Ask about system status, logs, or commands"
        />
        <div className="flex items-center justify-between gap-2">
          <label className="flex items-center gap-2 text-xs text-muted">
            <input
              type="checkbox"
              checked={aiIncludeOutput}
              onChange={(event) => setAiIncludeOutput(event.target.checked)}
            />
            Include terminal output
          </label>
          <button type="submit" className="inline-flex items-center gap-1.5 border border-accent bg-accent px-3 py-1.5 text-xs text-white">
            <Send className="h-3.5 w-3.5" aria-hidden="true" />
            Ask
          </button>
        </div>
      </form>

      <div className="min-h-24 flex-1 overflow-auto bg-surface/20 p-2 text-xs">
        {aiAnswer?.answer ? (
          <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={MARKDOWN_COMPONENTS}>
            {aiAnswer.answer}
          </ReactMarkdown>
        ) : (
          <div className="inline-flex items-center gap-2 text-muted">
            <Bot className="h-3.5 w-3.5" aria-hidden="true" />
            AI response will appear here
          </div>
        )}
      </div>
    </div>
  );
}
