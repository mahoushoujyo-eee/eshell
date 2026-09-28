/**
 * eShell's AI mark: a chat bubble holding a shell prompt, with the brand's
 * green cursor. `busy` blinks the cursor while the agent is responding.
 * The bubble and chevron follow `currentColor`; the cursor stays accent.
 */
export default function EshellAiMark({ busy = false, className = "h-4 w-4" }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <path
        d="M3.25 2.75h9.5a1.75 1.75 0 0 1 1.75 1.75v5.75A1.75 1.75 0 0 1 12.75 12H8.2L5 14.5V12H3.25A1.75 1.75 0 0 1 1.5 10.25V4.5a1.75 1.75 0 0 1 1.75-1.75Z"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinejoin="round"
      />
      <path
        d="m4.5 5.3 2.1 1.9-2.1 1.9"
        stroke="currentColor"
        strokeWidth="1.45"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M8.5 9.1h3"
        stroke="var(--es-accent)"
        strokeWidth="1.6"
        strokeLinecap="round"
        className={busy ? "animate-[es-blink_1s_steps(1,end)_infinite]" : undefined}
      />
    </svg>
  );
}
