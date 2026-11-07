import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  CircleStop,
  Folder,
  Loader2,
  Maximize2,
  Minimize2,
  Paperclip,
  Quote,
  Send,
  Square,
  TerminalSquare,
  TriangleAlert,
  X,
  Plus,
} from "lucide-react";
import { AcpModePicker, AcpSessionSettingsMenu } from "./acp/AcpPickers";
import AcpHistoryPanel from "./acp/AcpHistoryPanel";
import AcpPathPicker from "./acp/AcpPathPicker";
import AcpSessionTabs from "./acp/AcpSessionTabs";
import TranscriptEntry, { AcpAuthCard, PlanCard } from "./acp/AcpTranscript";
import AcpNoticeRow from "./acp/AcpNoticeRow";
import AcpAgentLogo from "../ai/AcpAgentLogo";
import AcpEnvWarningCard from "../ai/AcpEnvWarningCard";
import { formatAcpAgentSpawn } from "../../lib/acpAgentBrands";
import { visibleConfigOptions } from "../../lib/acpConfigOptions";
import { formatShellContextPreview } from "../../lib/ops-agent-shell-context";
import { useI18n } from "../../lib/i18n";

/**
 * ACP chat panel: a tab strip of live conversations over one shared state
 * machine (`useAcpAgent`).
 *
 * The panel is a pure view. Everything it shows comes from the active
 * conversation; every action targets that conversation by key. Conversations
 * are independent — opening a new one, switching tabs, or opening a historical
 * one never stops another, which is the whole point of the multi-conversation
 * model.
 */

// Reads one image file into a prompt attachment (base64 payload + preview URL).
// Oversized images are downscaled/re-encoded client-side: Codex-side image
// preparation silently replaces too-large images with an "omitted" placeholder,
// and smaller payloads cost fewer tokens anyway.
const MAX_IMAGE_DIMENSION = 1568;
const MAX_IMAGE_DATAURL_CHARS = 5 * 1024 * 1024;

const nextAttachmentId = () => `img-${Date.now()}-${Math.random().toString(16).slice(2)}`;

const attachmentFromDataUrl = (dataUrl, mimeType) => ({
  id: nextAttachmentId(),
  data: dataUrl.slice(dataUrl.indexOf(",") + 1),
  mimeType,
  previewUrl: dataUrl,
});

const normalizeImage = (dataUrl, mimeType) =>
  new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const scale = Math.min(1, MAX_IMAGE_DIMENSION / Math.max(image.width, image.height, 1));
      if (scale >= 1 && dataUrl.length <= MAX_IMAGE_DATAURL_CHARS) {
        resolve(attachmentFromDataUrl(dataUrl, mimeType));
        return;
      }
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(image.width * scale));
      canvas.height = Math.max(1, Math.round(image.height * scale));
      const context = canvas.getContext("2d");
      if (!context) {
        resolve(attachmentFromDataUrl(dataUrl, mimeType));
        return;
      }
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      let outMime = mimeType === "image/jpeg" ? "image/jpeg" : "image/png";
      let out = canvas.toDataURL(outMime, 0.9);
      if (out.length > MAX_IMAGE_DATAURL_CHARS) {
        outMime = "image/jpeg";
        out = canvas.toDataURL(outMime, 0.85);
      }
      resolve(attachmentFromDataUrl(out, outMime));
    };
    image.onerror = () => reject(new Error("image decode failed"));
    image.src = dataUrl;
  });

const readImageFile = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || "");
      normalizeImage(dataUrl, file.type || "image/png").then(resolve, reject);
    };
    reader.onerror = () => reject(reader.error || new Error("read failed"));
    reader.readAsDataURL(file);
  });

function StarterRow({ agent, onPick }) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      onClick={() => onPick(agent.id)}
      title={formatAcpAgentSpawn(agent)}
      className="flex w-full items-center gap-2.5 rounded-lg border border-border px-2.5 py-2 text-left transition-colors hover:border-border-strong hover:bg-hover"
    >
      <AcpAgentLogo agent={agent} className="h-7 w-7 shrink-0" />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-[13px] font-medium text-text">{agent.name}</span>
          {agent.running ? (
            <span
              title={t("Agent process running")}
              className="h-1.5 w-1.5 shrink-0 rounded-full bg-success"
            />
          ) : null}
        </span>
        <span className="mt-0.5 block truncate font-mono text-[10px] text-muted">
          {formatAcpAgentSpawn(agent)}
        </span>
      </span>
      <Plus className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden="true" />
    </button>
  );
}

export default function AcpAgentPanel({ acp }) {
  const { t } = useI18n();
  const {
    conversations,
    activeKey,
    setActiveKey,
    activeConversation,
    agents,
    openSession,
    closeSession,
    stopAgent,
    phase,
    session,
    authMethods,
    transcript,
    plan,
    commands,
    configOptions,
    usage,
    turnActive,
    draft,
    standaloneNotices,
    history,
    projects,
    addProject,
    deleteProject,
    startSession,
    resumeHistory,
    deleteHistoryRecord,
    sendPrompt,
    cancelTurn,
    setMode,
    setConfigOption,
    respondPermission,
    clearShellContext,
    setDraft,
    authenticate,
    runtimeEnv,
    envMissing,
    refreshRuntimeEnv,
  } = acp;

  const [historyOpen, setHistoryOpen] = useState(false);
  // Where the next conversation started from the starter screen should run:
  // null = the agent's own configured directory, otherwise a project row.
  const [starterProject, setStarterProject] = useState(null);
  // Composer popovers: null | "mode" | "settings".
  const [openMenu, setOpenMenu] = useState(null);
  // A long draft scrolls inside the 2-row composer, which hides the text being
  // edited. The box therefore grows on demand via a top-right toggle.
  const [composerExpanded, setComposerExpanded] = useState(false);
  const [composerOverflows, setComposerOverflows] = useState(false);
  const textareaRef = useRef(null);
  const composerRef = useRef(null);
  const composerMenuRef = useRef(null);
  const scrollRef = useRef(null);
  const panelRef = useRef(null);
  const nearBottomRef = useRef(true);
  // Transcript text selected for quoting: { text, x, y } or null.
  const [selectionQuote, setSelectionQuote] = useState(null);

  const ready = phase === "ready" && session != null;
  const starting = phase === "starting";
  const authActive = phase === "auth" || phase === "authenticating";
  const ended = phase === "ended";

  const activeAgent = useMemo(
    () => agents.find((agent) => agent.id === activeConversation?.agentId) || null,
    [agents, activeConversation],
  );
  const supportsImages = Boolean(session?.capabilities?.promptImage);
  const modes = session?.modes;
  // Agent-advertised selectors (model, thought level, ...). The mode mirror is
  // filtered out here because `modes` above already drives that same setting.
  const sessionConfigOptions = useMemo(
    () => (ready ? visibleConfigOptions(configOptions) : []),
    [configOptions, ready],
  );

  const attachments = draft?.attachments ?? [];
  const shellContext = draft?.shellContext ?? null;
  const question = draft?.text ?? "";

  const canSend =
    ready &&
    !turnActive &&
    (question.trim().length > 0 || attachments.length > 0 || shellContext != null);
  const usagePercent =
    usage && usage.size > 0 ? Math.min(100, Math.round((usage.used / usage.size) * 100)) : null;

  const openHistoryKeys = useMemo(
    () =>
      new Set(
        conversations
          .filter((row) => row.sessionId)
          .map((row) => `${row.agentId}:${row.sessionId}`),
      ),
    [conversations],
  );

  // Autoscroll while streaming unless the user scrolled up to read. Switching
  // conversations also jumps to the newest message, which is what makes a tab
  // click feel like switching rather than scrolling a shared transcript.
  useEffect(() => {
    const node = scrollRef.current;
    if (node && nearBottomRef.current) {
      node.scrollTop = node.scrollHeight;
    }
  }, [transcript, activeKey]);

  useEffect(() => {
    nearBottomRef.current = true;
  }, [activeKey]);

  const handleScroll = useCallback((event) => {
    const node = event.currentTarget;
    nearBottomRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 48;
    // The quote button is placed from the selection's viewport rect, so it
    // would float over the wrong paragraph once the text moves.
    setSelectionQuote(null);
  }, []);

  // Dismiss the quote button on an outside click, the same way the composer
  // popovers are dismissed — but keep the selection when the button itself is
  // pressed, or the click would never land.
  useEffect(() => {
    if (!selectionQuote) {
      return undefined;
    }
    const dismiss = (event) => {
      if (!event.target?.closest?.("[data-quote-popover]")) {
        setSelectionQuote(null);
      }
    };
    window.addEventListener("pointerdown", dismiss, true);
    return () => window.removeEventListener("pointerdown", dismiss, true);
  }, [selectionQuote]);

  // The expand affordance only earns its corner once the draft really
  // overflows, so measure instead of guessing from its length: how much wraps
  // depends on the panel width, which the user can drag at any time.
  useEffect(() => {
    const node = textareaRef.current;
    const box = composerRef.current;
    if (!node) {
      return undefined;
    }
    const measure = () => setComposerOverflows(node.scrollHeight > node.clientHeight + 1);
    measure();
    if (!box || typeof ResizeObserver === "undefined") {
      return undefined;
    }
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    return () => observer.disconnect();
  }, [question, composerExpanded, activeKey]);

  // Dismiss the composer popovers on outside click or Escape. Escape is
  // captured here so it closes the menu instead of bubbling up to App's
  // "close dock".
  useEffect(() => {
    if (!openMenu) {
      return undefined;
    }
    const handlePointerDown = (event) => {
      if (composerMenuRef.current?.contains(event.target)) {
        return;
      }
      setOpenMenu(null);
    };
    const handleKeyDown = (event) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpenMenu(null);
      }
    };
    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [openMenu]);

  const handleSend = useCallback(
    async (event) => {
      event?.preventDefault?.();
      if (!canSend) {
        return;
      }
      setComposerExpanded(false);
      nearBottomRef.current = true;
      await sendPrompt(question, attachments);
    },
    [attachments, canSend, question, sendPrompt],
  );

  /**
   * Appends a snippet to the draft and focuses the composer.
   *
   * Appending — rather than inserting at the caret — because both callers add a
   * block the user is about to talk about ("here is a file", "about this
   * paragraph"), and the sentence explaining it comes before the block in the
   * user's head anyway. Appending never splits text they already typed.
   */
  const appendToDraft = useCallback(
    (snippet) => {
      const addition = (snippet || "").trim();
      if (!addition) {
        return;
      }
      const current = question.trimEnd();
      setDraft({ text: current ? `${current}\n\n${addition}` : addition });
      // `requestAnimationFrame` lives on the fake window in tests but is not a
      // global there, so fall back to a timer.
      const schedule =
        typeof requestAnimationFrame === "function"
          ? requestAnimationFrame
          : (callback) => setTimeout(callback, 0);
      schedule(() => {
        const node = textareaRef.current;
        if (!node) {
          return;
        }
        node.focus();
        node.setSelectionRange(node.value.length, node.value.length);
      });
    },
    [question, setDraft],
  );

  // A path, not the file contents: the agent runs on this machine and can read
  // the file itself, which beats shipping a stale copy through the transcript.
  const quotePaths = useCallback(
    (paths) => paths.filter(Boolean).map((path) => `\`${path}\``).join("\n"),
    [],
  );

  const attachFiles = useCallback(
    async (paths) => {
      const snippet = quotePaths(paths);
      if (snippet) {
        appendToDraft(snippet);
      }
    },
    [appendToDraft, quotePaths],
  );

  const pickFiles = useCallback(async () => {
    try {
      const picked = await openDialog({
        multiple: true,
        directory: false,
        title: t("Attach file paths"),
      });
      const paths = Array.isArray(picked) ? picked : picked ? [picked] : [];
      await attachFiles(paths);
    } catch {
      // The dialog being unavailable (or cancelled) is not worth a notice.
    }
  }, [attachFiles, t]);

  // Drops are handled at the webview level: the page never receives real file
  // paths, only the shell does, so a plain HTML5 drop handler cannot work here.
  // Only drops inside this panel count — otherwise dragging a file anywhere in
  // the app would silently type into the agent prompt.
  useEffect(() => {
    let unlisten = null;
    let cancelled = false;
    const scale = window.devicePixelRatio || 1;
    void (async () => {
      try {
        const { getCurrentWebview } = await import("@tauri-apps/api/webview");
        const stop = await getCurrentWebview().onDragDropEvent((event) => {
          if (event.payload?.type !== "drop") {
            return;
          }
          const rect = panelRef.current?.getBoundingClientRect();
          const point = event.payload.position;
          if (rect && point) {
            const x = point.x / scale;
            const y = point.y / scale;
            if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
              return;
            }
          }
          void attachFiles(event.payload.paths ?? []);
        });
        if (cancelled) {
          stop?.();
        } else {
          unlisten = stop;
        }
      } catch {
        // Outside Tauri (tests, plain browser) there is nothing to listen to.
      }
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [attachFiles]);

  /** Turns a transcript selection into a quoted block. */
  const handleTranscriptSelection = useCallback(() => {
    const selection = window.getSelection?.();
    const text = selection?.toString?.().trim() ?? "";
    const anchor = selection?.anchorNode;
    const container = scrollRef.current;
    if (!text || !anchor || !container?.contains(anchor) || selection.rangeCount === 0) {
      setSelectionQuote(null);
      return;
    }
    const rect = selection.getRangeAt(0).getBoundingClientRect?.();
    const panelRect = panelRef.current?.getBoundingClientRect?.();
    if (!rect || !panelRect || (!rect.width && !rect.height)) {
      setSelectionQuote(null);
      return;
    }
    setSelectionQuote({
      text: text.length > 2000 ? `${text.slice(0, 2000)}…` : text,
      // Centred over the selection, kept inside the panel.
      x: Math.min(Math.max(rect.left + rect.width / 2, panelRect.left + 64), panelRect.right - 64),
      y: Math.min(rect.bottom + 8, panelRect.bottom - 40),
    });
  }, []);

  const quoteSelection = useCallback(() => {
    if (!selectionQuote) {
      return;
    }
    const quoted = selectionQuote.text
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n");
    appendToDraft(quoted);
    setSelectionQuote(null);
    window.getSelection?.()?.removeAllRanges?.();
  }, [appendToDraft, selectionQuote]);

  const addImageFiles = useCallback(
    async (files) => {
      if (!supportsImages) {
        return;
      }
      const imageFiles = [...files].filter((file) => file.type.startsWith("image/"));
      if (imageFiles.length === 0) {
        return;
      }
      try {
        const loaded = await Promise.all(imageFiles.map(readImageFile));
        setDraft({ attachments: [...attachments, ...loaded] });
      } catch {
        // Unreadable files are dropped silently; the picker can be retried.
      }
    },
    [attachments, setDraft, supportsImages],
  );

  const handleNewConversation = useCallback(
    (agentId) => {
      setHistoryOpen(false);
      void openSession({ agentId });
    },
    [openSession],
  );

  // The starter screen's agent rows honour the path picked next to the title;
  // the tab strip's "+" keeps starting in the agent's own directory, because no
  // path picker is visible while tabs are open and silently reusing a choice
  // made in another screen would be a surprise.
  const handleStarterStart = useCallback(
    (agentId) => {
      void openSession({ agentId, project: starterProject });
    },
    [openSession, starterProject],
  );

  // The agents' directories only differ when the user configured them to, so a
  // shared one can stand in for "default path" instead of an abstract label.
  const commonAgentCwd = useMemo(() => {
    const first = agents[0]?.cwd;
    if (!first) {
      return null;
    }
    return agents.every((agent) => (agent.cwd || "") === first) ? first : null;
  }, [agents]);

  const handleCloseConversation = useCallback(
    (key) => {
      void closeSession(key);
    },
    [closeSession],
  );

  const handleOpenHistoryRecord = useCallback(
    (record) => {
      setHistoryOpen(false);
      void resumeHistory(record);
    },
    [resumeHistory],
  );

  const handleNewSessionInProject = useCallback(
    (project, agentId) => {
      setHistoryOpen(false);
      void startSession({ project, agentId });
    },
    [startSession],
  );

  // Retry = drop this tab (which stops the process if it was the last one) and
  // open a fresh conversation with the same agent and folder.
  const handleRetry = useCallback(async () => {
    if (!activeConversation) {
      return;
    }
    const { key, agentId, projectId, cwd } = activeConversation;
    await closeSession(key);
    await openSession({ agentId, project: { id: projectId ?? null, path: cwd ?? null } });
  }, [activeConversation, closeSession, openSession]);

  const commandSuggestions = useMemo(() => {
    if (!question.startsWith("/") || question.includes(" ") || commands.length === 0) {
      return [];
    }
    const prefix = question.slice(1).toLowerCase();
    return commands
      .filter((command) => command.name.toLowerCase().startsWith(prefix))
      .slice(0, 6);
  }, [commands, question]);

  const renderBody = () => {
    if (!activeConversation) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-3 px-4 py-6 text-center">
          {envMissing ? <AcpEnvWarningCard env={runtimeEnv} onRecheck={() => refreshRuntimeEnv(true)} /> : null}
          {standaloneNotices.map((entry) => (
            <AcpNoticeRow key={entry.id} entry={entry} />
          ))}
          {agents.length === 0 ? (
            <p className="text-sm text-muted">{t("No agent configured")}</p>
          ) : (
            <div className="w-full max-w-full space-y-2">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-medium text-text">{t("Start a conversation")}</p>
                <AcpPathPicker
                  projects={projects}
                  value={starterProject}
                  defaultHint={commonAgentCwd}
                  onChange={setStarterProject}
                  onAddProject={addProject}
                />
              </div>
              <div className="space-y-1.5 text-left">
                {agents.map((agent) => (
                  <StarterRow key={agent.id} agent={agent} onPick={handleStarterStart} />
                ))}
              </div>
            </div>
          )}
        </div>
      );
    }

    if (starting) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-muted">
          <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
          <span>{t("Starting…")}</span>
          {activeAgent ? (
            <span className="max-w-full break-all px-4 text-center font-mono text-[10px] text-subtle">
              {formatAcpAgentSpawn(activeAgent)}
            </span>
          ) : null}
        </div>
      );
    }

    if (ended) {
      return (
        <div className="space-y-2">
          {envMissing ? (
            <AcpEnvWarningCard env={runtimeEnv} onRecheck={() => refreshRuntimeEnv(true)} />
          ) : null}
          <div className="rounded-lg border border-warning/35 bg-warning/8 px-3 py-2.5 text-xs">
            <div className="flex items-center gap-2 text-warning">
              <TriangleAlert className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span className="text-sm font-semibold">
                {activeConversation.failed
                  ? t("Could not start this conversation")
                  : t("Session ended")}
              </span>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={handleRetry}
                className="inline-flex items-center gap-1.5 rounded-md bg-accent px-2.5 py-1 font-medium text-on-accent hover:bg-accent/88"
              >
                {t("Start again")}
              </button>
              {activeConversation.failed ? (
                <button
                  type="button"
                  onClick={() => void stopAgent(activeConversation.agentId)}
                  className="inline-flex items-center gap-1.5 rounded-md border border-border-strong px-2.5 py-1 font-medium text-text/88 hover:bg-hover"
                >
                  <CircleStop className="h-3.5 w-3.5" aria-hidden="true" />
                  {t("Stop agent process")}
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => handleCloseConversation(activeConversation.key)}
                className="inline-flex items-center gap-1.5 rounded-md border border-border-strong px-2.5 py-1 font-medium text-text/88 hover:bg-hover"
              >
                {t("Close conversation")}
              </button>
            </div>
          </div>
          {transcript.map((entry) => (
            <TranscriptEntry key={entry.id} entry={entry} onRespondPermission={respondPermission} />
          ))}
        </div>
      );
    }

    return (
      <div className="space-y-2">
        {envMissing ? (
          <AcpEnvWarningCard env={runtimeEnv} onRecheck={() => refreshRuntimeEnv(true)} />
        ) : null}
        {authActive ? (
          <AcpAuthCard
            methods={authMethods}
            authenticating={phase === "authenticating"}
            onAuthenticate={authenticate}
            onCancel={() => handleCloseConversation(activeConversation.key)}
          />
        ) : null}
        {transcript.map((entry) => (
          <TranscriptEntry key={entry.id} entry={entry} onRespondPermission={respondPermission} />
        ))}
        {turnActive ? (
          <div className="flex items-center gap-2 px-1 text-xs text-muted">
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            {t("Agent working…")}
          </div>
        ) : null}
        {ready && transcript.length === 0 ? (
          <div className="pt-8 text-center text-xs text-muted">
            {t("Session ready — message the agent to get started.")}
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <div
      ref={panelRef}
      className="relative flex h-full min-h-0 flex-col overflow-hidden bg-surface"
    >
      <AcpSessionTabs
        conversations={conversations}
        activeKey={activeKey}
        agents={agents}
        historyOpen={historyOpen}
        onSelect={setActiveKey}
        onClose={handleCloseConversation}
        onNewConversation={handleNewConversation}
        onOpenHistory={() => setHistoryOpen((prev) => !prev)}
        onStopAgent={(agentId) => void stopAgent(agentId)}
      />

      {activeConversation ? (
        <div className="flex h-7 shrink-0 items-center gap-2 border-b border-border/70 px-2.5 text-[11px] text-muted">
          <AcpAgentLogo agent={activeAgent} className="h-3.5 w-3.5 shrink-0" />
          <span className="shrink-0 font-medium text-text/88">
            {activeAgent?.name || activeConversation.agentName}
          </span>
          <span
            className="flex min-w-0 items-center gap-1"
            title={activeConversation.cwd || t("Default working directory")}
          >
            <Folder className="h-3 w-3 shrink-0" aria-hidden="true" />
            <span className="truncate font-mono text-[10px]">
              {activeConversation.cwd || t("Default working directory")}
            </span>
          </span>
          <span className="ml-auto flex shrink-0 items-center gap-2">
            {usagePercent != null ? (
              <span
                className="rounded bg-hover px-1.5 py-0.5 font-mono text-[10px] tabular-nums"
                title={`${usage.used} / ${usage.size}`}
              >
                {usagePercent}%
              </span>
            ) : null}
          </span>
        </div>
      ) : null}

      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          onMouseUp={handleTranscriptSelection}
          className="scroll-region min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-3 py-3"
        >
          {renderBody()}
        </div>

        {historyOpen ? (
          <AcpHistoryPanel
            projects={projects}
            history={history}
            agents={agents}
            activeAgentId={activeConversation?.agentId ?? null}
            activeAgentName={activeAgent?.name ?? null}
            activeAgentCwd={activeAgent?.cwd ?? null}
            openKeys={openHistoryKeys}
            onOpen={handleOpenHistoryRecord}
            onDelete={(row) => void deleteHistoryRecord(row.id)}
            onPickAgent={handleNewSessionInProject}
            onAddProject={() => void addProject()}
            onDeleteProject={(project) => void deleteProject(project.id)}
            onClose={() => setHistoryOpen(false)}
          />
        ) : null}
      </div>

      {activeConversation && plan && plan.length > 0 ? <PlanCard plan={plan} /> : null}

      <div className="relative shrink-0 border-t border-border">
        {commandSuggestions.length > 0 ? (
          <div className="absolute inset-x-3 bottom-full z-10 mb-1 overflow-hidden rounded-lg border border-border bg-elevated p-1 shadow-overlay">
            {commandSuggestions.map((command) => (
              <button
                key={command.name}
                type="button"
                onClick={() => setDraft({ text: `/${command.name} ` })}
                className="flex w-full items-baseline gap-2 rounded-md px-2.5 py-1.5 text-left text-xs hover:bg-hover"
              >
                <span className="shrink-0 font-mono font-medium text-accent">
                  /{command.name}
                </span>
                <span className="min-w-0 flex-1 truncate text-muted">
                  {command.description}
                  {command.inputHint ? ` · ${command.inputHint}` : ""}
                </span>
              </button>
            ))}
          </div>
        ) : null}
        <form onSubmit={handleSend} className="px-3 pt-2.5 pb-3">
          {shellContext ? (
            <div className="mb-2 flex items-center gap-2 rounded-md border border-border bg-panel px-2 py-1.5 text-xs">
              <TerminalSquare className="h-3.5 w-3.5 shrink-0 text-accent" aria-hidden="true" />
              <span className="shrink-0 font-medium text-text/88">
                {shellContext.sessionName}
              </span>
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted">
                {formatShellContextPreview(shellContext.content)}
              </span>
              <span className="shrink-0 rounded bg-warm px-1.5 py-0.5 font-mono text-[10px] text-muted">
                {Array.from(shellContext.content).length}
              </span>
              <button
                type="button"
                onClick={clearShellContext}
                aria-label={t("Remove terminal selection")}
                className="shrink-0 rounded p-0.5 text-muted hover:text-danger"
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </div>
          ) : null}
          {attachments.length > 0 ? (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {attachments.map((image) => (
                <div key={image.id} className="relative">
                  <img
                    src={image.previewUrl}
                    alt=""
                    className="h-12 w-12 rounded-md border border-border object-cover"
                  />
                  <button
                    type="button"
                    onClick={() =>
                      setDraft({
                        attachments: attachments.filter((item) => item.id !== image.id),
                      })
                    }
                    aria-label={t("Remove image")}
                    className="absolute -right-1.5 -top-1.5 rounded-full border border-border bg-panel p-0.5 text-muted hover:text-danger"
                  >
                    <X className="h-3 w-3" aria-hidden="true" />
                  </button>
                </div>
              ))}
            </div>
          ) : null}
          {/* One bordered box holding the textarea and a footer strip, so the
              session-mode picker and send button read as part of the composer
              (images arrive by paste only — there is no attach button). */}
          <div
            ref={composerRef}
            className={[
              "relative flex flex-col overflow-visible rounded-lg border border-border-strong bg-panel transition-colors focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/15",
              composerExpanded ? "h-[min(52vh,26rem)]" : "",
            ].join(" ")}
          >
            <textarea
              ref={textareaRef}
              value={question}
              onChange={(event) => setDraft({ text: event.target.value })}
              onKeyDown={(event) => {
                // Collapse first: App's own Escape handler closes the whole dock,
                // so this must not bubble.
                if (event.key === "Escape" && composerExpanded) {
                  event.preventDefault();
                  event.stopPropagation();
                  setComposerExpanded(false);
                  return;
                }
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  handleSend(event);
                }
              }}
              onPaste={(event) => {
                const files = event.clipboardData?.files;
                if (files && files.length > 0 && supportsImages) {
                  event.preventDefault();
                  void addImageFiles(files);
                }
              }}
              rows={2}
              disabled={!ready}
              placeholder={
                ready
                  ? t("Message the agent…")
                  : authActive
                    ? t("Sign in to continue")
                    : starting
                      ? t("Starting…")
                      : t("Start a conversation first")
              }
              className={[
                "min-h-0 w-full resize-none border-0 bg-transparent px-3 py-2.5 text-[13px] leading-6 text-text outline-none placeholder:text-subtle",
                composerOverflows || composerExpanded ? "pr-9" : "",
                composerExpanded ? "flex-1" : "",
              ].join(" ")}
            />
            {/* Only worth a corner once the draft overflows — and it has to stay
                put while expanded, since an expanded box usually no longer
                overflows and would otherwise strand the user with no way back. */}
            {composerOverflows || composerExpanded ? (
              <button
                type="button"
                onClick={() => setComposerExpanded((prev) => !prev)}
                title={composerExpanded ? t("Collapse input") : t("Expand input")}
                aria-label={composerExpanded ? t("Collapse input") : t("Expand input")}
                aria-expanded={composerExpanded}
                className="absolute top-1.5 right-1.5 z-10 inline-flex h-6 w-6 items-center justify-center rounded-md text-muted transition-colors hover:bg-hover hover:text-text"
              >
                {composerExpanded ? (
                  <Minimize2 className="h-3.5 w-3.5" aria-hidden="true" />
                ) : (
                  <Maximize2 className="h-3.5 w-3.5" aria-hidden="true" />
                )}
              </button>
            ) : null}
            <div ref={composerMenuRef} className="relative flex items-end gap-1.5 px-2 pb-1.5">
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
                {ready && modes?.availableModes?.length ? (
                  <AcpModePicker
                    modes={modes}
                    open={openMenu === "mode"}
                    onToggle={() => setOpenMenu((prev) => (prev === "mode" ? null : "mode"))}
                    onSelect={(modeId) => {
                      setMode(modeId);
                      setOpenMenu(null);
                    }}
                  />
                ) : null}
                {ready ? (
                  <AcpSessionSettingsMenu
                    options={sessionConfigOptions}
                    open={openMenu === "settings"}
                    onToggle={() =>
                      setOpenMenu((prev) => (prev === "settings" ? null : "settings"))
                    }
                    onSelect={(configId, value) => {
                      void setConfigOption(configId, value);
                      setOpenMenu(null);
                    }}
                  />
                ) : null}
                {ready ? (
                  <button
                    type="button"
                    onClick={() => void pickFiles()}
                    title={t("Attach file paths")}
                    aria-label={t("Attach file paths")}
                    className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-muted transition-colors hover:bg-hover hover:text-text"
                  >
                    <Paperclip className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                ) : null}
              </div>
              {turnActive ? (
                <button
                  type="button"
                  onClick={cancelTurn}
                  title={t("Cancel turn")}
                  className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border-strong text-text transition-colors hover:bg-danger/10 hover:text-danger"
                >
                  <Square className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              ) : (
                <button
                  type="submit"
                  disabled={!canSend}
                  title={t("Send")}
                  className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-accent text-on-accent transition-colors hover:bg-accent/88 disabled:opacity-40"
                >
                  <Send className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              )}
            </div>
          </div>
        </form>
      </div>

      {/* Quoting lives next to the selection, like a chat app's "ask about
          this" affordance: pick a paragraph, hit the pill, and it lands in the
          composer as a blockquote ready for the question. */}
      {selectionQuote ? (
        <button
          type="button"
          data-quote-popover="true"
          onMouseDown={(event) => event.preventDefault()}
          onClick={quoteSelection}
          style={{ left: selectionQuote.x, top: selectionQuote.y }}
          title={t("Quote in reply")}
          className="fixed z-40 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-border-strong bg-elevated px-2.5 py-1 text-[11px] font-medium text-text shadow-overlay transition-colors hover:bg-hover"
        >
          <Quote className="h-3 w-3 text-accent" aria-hidden="true" />
          {t("Quote in reply")}
        </button>
      ) : null}
    </div>
  );
}
