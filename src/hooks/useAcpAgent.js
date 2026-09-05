import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { normalizeShellContextAttachment } from "../lib/ops-agent-shell-context";
import { api } from "../lib/tauri-api";

/**
 * State machine for one ACP agent session, backed by the `acp-agent-stream`
 * Tauri event and the `acp_*` commands.
 *
 * Transcript entries (in arrival order):
 * - { id, type: "user", text, images?, context? }  — context: attached terminal selection
 * - { id, type: "assistant", text }            — streamed, merged per segment
 * - { id, type: "thought", text }              — agent reasoning, merged per segment
 * - { id, type: "tool", tool }                 — updated in place by toolCallId
 * - { id, type: "permission", requestId, toolCall, options, resolution, resolving }
 * - { id, type: "notice", tone, code, detail } — codes translated by the panel
 *
 * Finished transcripts persist to `.eshell-data/acp_sessions/`; reopening a
 * session attempts a native `session/load` resume (the agent replays history
 * as stream events) and falls back to a fresh session when unsupported.
 */

const STREAM_EVENT = "acp-agent-stream";
const HISTORY_TITLE_LENGTH = 48;

let entrySeq = 0;
const nextEntryId = () => {
  entrySeq += 1;
  return `acp-entry-${entrySeq}`;
};

const normalizeTool = (view) => ({
  toolCallId: view.toolCallId,
  title: view.title || "",
  kind: view.kind || "",
  status: view.status || "pending",
  content: Array.isArray(view.content) ? view.content : [],
  locations: Array.isArray(view.locations) ? view.locations : [],
  rawInput: view.rawInput ?? null,
  rawOutput: view.rawOutput ?? null,
});

const mergeToolView = (tool, view) => {
  const next = { ...tool };
  if (view.title != null) next.title = view.title;
  if (view.kind != null) next.kind = view.kind;
  if (view.status != null) next.status = view.status;
  if (view.content != null) next.content = view.content;
  if (view.locations != null) next.locations = view.locations;
  if (view.rawInput != null) next.rawInput = view.rawInput;
  if (view.rawOutput != null) next.rawOutput = view.rawOutput;
  return next;
};

// History records must stay lean: keep image mime types (for the badge) but
// drop the base64 payloads.
const sanitizeEntriesForHistory = (entries) =>
  entries
    .filter((entry) => entry.type !== "notice")
    .map((entry) => {
      if (entry.type === "user" && Array.isArray(entry.images) && entry.images.length > 0) {
        return { ...entry, images: entry.images.map((image) => ({ mimeType: image.mimeType })) };
      }
      if (entry.type === "permission") {
        return { ...entry, resolving: false };
      }
      return entry;
    });

export function useAcpAgent() {
  const [agents, setAgents] = useState([]);
  const [activeAgentId, setActiveAgentId] = useState(null);
  // idle | starting | auth (sign-in required) | authenticating | ready
  const [phase, setPhase] = useState("idle");
  // { agentId, agentName, id, modes, agentInfo, capabilities, createdAt }
  const [session, setSession] = useState(null);
  const [authMethods, setAuthMethods] = useState([]);
  const [transcript, setTranscript] = useState([]);
  const [plan, setPlan] = useState(null);
  const [commands, setCommands] = useState([]);
  // Session config options (model, thought level, ...). Agents replace the
  // whole set on every change, so this is never merged.
  const [configOptions, setConfigOptions] = useState([]);
  const [usage, setUsage] = useState(null);
  const [turnActive, setTurnActive] = useState(false);
  const [history, setHistory] = useState([]);
  // Terminal selection staged for the next prompt ({sessionId, sessionName, content}).
  const [shellContext, setShellContext] = useState(null);

  // Agent id the panel is engaged with; set as soon as start begins so events
  // arriving during the handshake (e.g. session/load replay) are kept.
  const engagedAgentRef = useRef(null);
  const pendingResumeRef = useRef(null);
  const sessionRef = useRef(null);
  sessionRef.current = session;
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const transcriptRef = useRef(transcript);
  transcriptRef.current = transcript;
  const agentsRef = useRef(agents);
  agentsRef.current = agents;
  const shellContextRef = useRef(shellContext);
  shellContextRef.current = shellContext;

  // Stages a terminal selection as context for the next prompt (replaces any
  // previously staged selection, mirroring the legacy assistant behavior).
  const attachShellContext = useCallback((selection) => {
    const normalized = normalizeShellContextAttachment(selection);
    if (normalized) {
      setShellContext(normalized);
    }
  }, []);

  const clearShellContext = useCallback(() => setShellContext(null), []);

  const pushNotice = useCallback((tone, code, detail = "") => {
    setTranscript((prev) => [
      ...prev,
      { id: nextEntryId(), type: "notice", tone, code, detail: String(detail || "") },
    ]);
  }, []);

  const appendStreamText = useCallback((type, chunk) => {
    if (typeof chunk !== "string" || chunk.length === 0) {
      return;
    }
    setTranscript((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.type === type) {
        const next = prev.slice(0, -1);
        next.push({ ...last, text: last.text + chunk });
        return next;
      }
      return [...prev, { id: nextEntryId(), type, text: chunk }];
    });
  }, []);

  const mergeToolCall = useCallback((view) => {
    if (!view || !view.toolCallId) {
      return;
    }
    setTranscript((prev) => {
      const index = prev.findIndex(
        (entry) => entry.type === "tool" && entry.tool.toolCallId === view.toolCallId,
      );
      if (index === -1) {
        return [...prev, { id: nextEntryId(), type: "tool", tool: normalizeTool(view) }];
      }
      const next = [...prev];
      next[index] = { ...next[index], tool: mergeToolView(next[index].tool, view) };
      return next;
    });
  }, []);

  const resolvePermissionEntry = useCallback((resolution) => {
    if (!resolution || !resolution.requestId) {
      return;
    }
    setTranscript((prev) =>
      prev.map((entry) =>
        entry.type === "permission" && entry.requestId === resolution.requestId
          ? {
              ...entry,
              resolving: false,
              resolution: {
                optionId: resolution.optionId ?? null,
                cancelled: Boolean(resolution.cancelled),
              },
            }
          : entry,
      ),
    );
  }, []);

  const refreshAgents = useCallback(async () => {
    try {
      const rows = await api.acpAgentList();
      if (Array.isArray(rows)) {
        setAgents(rows);
        setActiveAgentId((current) => current || rows[0]?.id || null);
      }
    } catch {
      // Listing failures surface once the user tries to start an agent.
    }
  }, []);

  const refreshHistory = useCallback(async () => {
    try {
      const rows = await api.acpHistoryList();
      if (Array.isArray(rows)) {
        setHistory(rows);
      }
    } catch {
      // History is best-effort; the panel just shows an empty list.
    }
  }, []);

  useEffect(() => {
    void refreshAgents();
    void refreshHistory();
  }, [refreshAgents, refreshHistory]);

  // Persists the current transcript; called after each turn and on stop.
  const saveHistory = useCallback(async () => {
    const current = sessionRef.current;
    if (!current?.id) {
      return;
    }
    const entries = transcriptRef.current;
    const firstUser = entries.find((entry) => entry.type === "user");
    if (!firstUser) {
      return;
    }
    const title =
      firstUser.text.replaceAll("\n", " ").slice(0, HISTORY_TITLE_LENGTH) ||
      firstUser.text.slice(0, HISTORY_TITLE_LENGTH);
    try {
      await api.acpHistorySave({
        id: current.id,
        agentId: current.agentId,
        agentName: current.agentName || current.agentId,
        title,
        createdAt: current.createdAt || "",
        updatedAt: "",
        transcript: sanitizeEntriesForHistory(entries),
      });
      void refreshHistory();
    } catch {
      // Persistence is best-effort; the live session is unaffected.
    }
  }, [refreshHistory]);

  // Route stream events for the engaged agent into panel state.
  useEffect(() => {
    const unlistenPromise = listen(STREAM_EVENT, (event) => {
      const payload = event?.payload;
      if (!payload || typeof payload !== "object") {
        return;
      }
      if (!engagedAgentRef.current || payload.agentId !== engagedAgentRef.current) {
        return;
      }
      switch (payload.stage) {
        case "delta":
          appendStreamText("assistant", payload.chunk);
          break;
        case "thought":
          appendStreamText("thought", payload.chunk);
          break;
        case "user":
          // User chunks only arrive as `session/load` replay (during start);
          // live turns already pushed the entry locally.
          if (phaseRef.current !== "ready") {
            appendStreamText("user", payload.chunk);
          }
          break;
        case "tool_call":
        case "tool_call_update":
          mergeToolCall(payload.toolCall);
          break;
        case "plan":
          setPlan(Array.isArray(payload.plan) ? payload.plan : []);
          break;
        case "commands":
          setCommands(Array.isArray(payload.commands) ? payload.commands : []);
          break;
        case "config_options":
          setConfigOptions(Array.isArray(payload.configOptions) ? payload.configOptions : []);
          break;
        case "mode":
          if (payload.currentModeId) {
            setSession((prev) =>
              prev
                ? {
                    ...prev,
                    modes: {
                      availableModes: prev.modes?.availableModes || [],
                      currentModeId: payload.currentModeId,
                    },
                  }
                : prev,
            );
          }
          break;
        case "usage":
          setUsage(payload.usage || null);
          break;
        case "permission_request":
          if (payload.permission?.requestId) {
            setTranscript((prev) => [
              ...prev,
              {
                id: nextEntryId(),
                type: "permission",
                requestId: payload.permission.requestId,
                toolCall: payload.permission.toolCall
                  ? normalizeTool(payload.permission.toolCall)
                  : null,
                options: Array.isArray(payload.permission.options)
                  ? payload.permission.options
                  : [],
                resolution: null,
                resolving: false,
              },
            ]);
          }
          break;
        case "permission_resolved":
          resolvePermissionEntry(payload.permissionResolution);
          break;
        case "stopped":
          void saveHistory();
          engagedAgentRef.current = null;
          pendingResumeRef.current = null;
          setPhase("idle");
          setTurnActive(false);
          setSession(null);
          setAuthMethods([]);
          setPlan(null);
          setCommands([]);
          setConfigOptions([]);
          setUsage(null);
          if (payload.error) {
            pushNotice("error", "agent-error", payload.error);
          } else {
            pushNotice("info", "session-ended");
          }
          void refreshAgents();
          break;
        default:
          break;
      }
    });
    return () => {
      void unlistenPromise.then((unlisten) => {
        if (typeof unlisten === "function") {
          unlisten();
        }
      });
    };
  }, [
    appendStreamText,
    mergeToolCall,
    pushNotice,
    refreshAgents,
    resolvePermissionEntry,
    saveHistory,
  ]);

  const applyStartInfo = useCallback(
    (agentId, info) => {
      const agentName =
        agentsRef.current.find((agent) => agent.id === agentId)?.name || agentId;
      setSession({
        agentId,
        agentName,
        id: info.sessionId,
        modes: info.modes || null,
        agentInfo: info.agentInfo || null,
        capabilities: info.capabilities || null,
        createdAt: new Date().toISOString(),
      });
      setAuthMethods([]);
      setConfigOptions(Array.isArray(info.configOptions) ? info.configOptions : []);
      setPhase("ready");
      if (pendingResumeRef.current && !info.resumed) {
        pushNotice("info", "resume-fallback");
      }
      pendingResumeRef.current = null;
      void refreshAgents();
    },
    [pushNotice, refreshAgents],
  );

  const startAgent = useCallback(
    async (agentId, resumeSessionId = null) => {
      if (!agentId || phaseRef.current !== "idle") {
        return;
      }
      setPhase("starting");
      setTranscript([]);
      setAuthMethods([]);
      setPlan(null);
      setCommands([]);
      setConfigOptions([]);
      setUsage(null);
      engagedAgentRef.current = agentId;
      pendingResumeRef.current = resumeSessionId;
      try {
        const info = await api.acpAgentStart(agentId, resumeSessionId);
        if (info.authRequired) {
          // Connection stays alive parked; the user picks a sign-in method and
          // `authenticate` completes the session (retrying the resume too).
          setAuthMethods(Array.isArray(info.authMethods) ? info.authMethods : []);
          setPhase("auth");
          return;
        }
        applyStartInfo(agentId, info);
      } catch (err) {
        engagedAgentRef.current = null;
        pendingResumeRef.current = null;
        setPhase("idle");
        pushNotice("error", "start-failed", err);
        // The failure may be "this agent already has an active session"; the
        // refreshed `running` flag is what lets the panel offer to reclaim it.
        void refreshAgents();
      }
    },
    [applyStartInfo, pushNotice, refreshAgents],
  );

  const start = useCallback(() => startAgent(activeAgentId), [activeAgentId, startAgent]);

  // Reopens a persisted session: native `session/load` resume when the agent
  /// supports it (transcript rebuilds from the replay), fresh session otherwise.
  const resumeHistory = useCallback(
    async (record) => {
      if (!record?.id || !record?.agentId || phaseRef.current !== "idle") {
        return;
      }
      setActiveAgentId(record.agentId);
      await startAgent(record.agentId, record.id);
    },
    [startAgent],
  );

  const authenticate = useCallback(
    async (methodId) => {
      const agentId = engagedAgentRef.current;
      if (!agentId || !methodId) {
        return;
      }
      setPhase("authenticating");
      try {
        const info = await api.acpAgentAuthenticate(agentId, methodId);
        applyStartInfo(agentId, info);
      } catch (err) {
        // The agent may have died mid sign-in; `stopped` already reset state.
        if (engagedAgentRef.current === agentId) {
          setPhase("auth");
          pushNotice("error", "auth-failed", err);
        }
      }
    },
    [applyStartInfo, pushNotice],
  );

  // Stops the engaged agent, or an explicitly named one. The explicit form
  // exists to reclaim an orphaned backend runner: the Rust registry outlives
  // the webview, so a reload (dev HMR, devtools) leaves a live agent process
  // that no frontend state points at any more — `acp_agent_start` then refuses
  // with "already has an active session" and nothing here could clear it.
  const stop = useCallback(
    async (agentId = null) => {
      // Works from the sign-in phases too, where no session exists yet.
      const targetId = agentId || sessionRef.current?.agentId || engagedAgentRef.current;
      if (!targetId) {
        return;
      }
      try {
        // The resulting `stopped` stream event resets phase/session state, but
        // only when that agent is the engaged one — the stream handler filters
        // on `engagedAgentRef`. Reclaiming an orphan is invisible to it, so
        // refresh the list here to pick up `running: false`.
        await api.acpAgentStop(targetId);
        if (targetId !== engagedAgentRef.current) {
          void refreshAgents();
        }
      } catch (err) {
        pushNotice("error", "agent-error", err);
      }
    },
    [pushNotice, refreshAgents],
  );

  // Reclaims an orphaned runner and immediately opens a fresh session on it.
  const reclaimAndStart = useCallback(
    async (agentId) => {
      const targetId = agentId || activeAgentId;
      if (!targetId) {
        return;
      }
      await stop(targetId);
      await startAgent(targetId);
    },
    [activeAgentId, startAgent, stop],
  );

  const sendPrompt = useCallback(
    async (text, images = []) => {
      const current = sessionRef.current;
      const trimmed = String(text || "").trim();
      const attachments = Array.isArray(images) ? images : [];
      const context = shellContextRef.current;
      if (!current || (!trimmed && attachments.length === 0 && !context) || turnActive) {
        return false;
      }
      // The staged terminal selection travels as a fenced block appended to
      // the typed text; the transcript keeps it structured for rendering.
      const outgoing = context
        ? `${trimmed}${trimmed ? "\n\n" : ""}Terminal selection from "${context.sessionName}":\n\`\`\`\n${context.content}\n\`\`\``
        : trimmed;
      setShellContext(null);
      setTranscript((prev) => [
        ...prev,
        {
          id: nextEntryId(),
          type: "user",
          text: trimmed,
          images: attachments.map((image) => ({
            mimeType: image.mimeType,
            previewUrl: image.previewUrl,
          })),
          ...(context
            ? { context: { sessionName: context.sessionName, content: context.content } }
            : {}),
        },
      ]);
      setTurnActive(true);
      try {
        const result = await api.acpSessionPrompt(
          current.agentId,
          current.id,
          outgoing,
          attachments.map((image) => ({ data: image.data, mimeType: image.mimeType })),
        );
        const stopReason = result?.stopReason;
        if (stopReason && stopReason !== "end_turn") {
          pushNotice("info", "turn-stopped", stopReason);
        }
      } catch (err) {
        // A stop that raced the prompt already reported through `stopped`.
        if (sessionRef.current) {
          pushNotice("error", "turn-failed", err);
        }
      } finally {
        setTurnActive(false);
        void saveHistory();
      }
      return true;
    },
    [pushNotice, saveHistory, turnActive],
  );

  const cancelTurn = useCallback(async () => {
    const current = sessionRef.current;
    if (!current) {
      return;
    }
    try {
      await api.acpSessionCancel(current.agentId, current.id);
    } catch {
      // Cancellation is best-effort; prompt settling clears the turn state.
    }
  }, []);

  const setMode = useCallback(
    async (modeId) => {
      const current = sessionRef.current;
      if (!current || !modeId) {
        return;
      }
      const previousModeId = current.modes?.currentModeId ?? null;
      setSession((prev) =>
        prev
          ? {
              ...prev,
              modes: {
                availableModes: prev.modes?.availableModes || [],
                currentModeId: modeId,
              },
            }
          : prev,
      );
      try {
        await api.acpSessionSetMode(current.agentId, current.id, modeId);
      } catch (err) {
        setSession((prev) =>
          prev && previousModeId
            ? {
                ...prev,
                modes: {
                  availableModes: prev.modes?.availableModes || [],
                  currentModeId: previousModeId,
                },
              }
            : prev,
        );
        pushNotice("error", "mode-failed", err);
      }
    },
    [pushNotice],
  );

  // Applies one config option. The agent answers with the full updated set, so
  // the reply is authoritative — no optimistic merge, and a failure leaves the
  // previous set untouched.
  const setConfigOption = useCallback(
    async (configId, value) => {
      const current = sessionRef.current;
      if (!current || !configId) {
        return;
      }
      try {
        const updated = await api.acpSessionSetConfigOption(
          current.agentId,
          current.id,
          configId,
          value,
        );
        if (Array.isArray(updated)) {
          setConfigOptions(updated);
        }
      } catch (err) {
        pushNotice("error", "config-option-failed", err);
      }
    },
    [pushNotice],
  );

  const respondPermission = useCallback(
    async (requestId, optionId) => {
      const current = sessionRef.current;
      if (!current || !requestId) {
        return;
      }
      setTranscript((prev) =>
        prev.map((entry) =>
          entry.type === "permission" && entry.requestId === requestId
            ? { ...entry, resolving: true }
            : entry,
        ),
      );
      try {
        await api.acpPermissionRespond(current.agentId, requestId, optionId ?? null);
        resolvePermissionEntry({
          requestId,
          optionId: optionId ?? null,
          cancelled: optionId == null,
        });
      } catch (err) {
        setTranscript((prev) =>
          prev.map((entry) =>
            entry.type === "permission" && entry.requestId === requestId
              ? { ...entry, resolving: false }
              : entry,
          ),
        );
        pushNotice("error", "permission-failed", err);
      }
    },
    [pushNotice, resolvePermissionEntry],
  );

  const getHistoryRecord = useCallback(async (id) => {
    return api.acpHistoryGet(id);
  }, []);

  const deleteHistoryRecord = useCallback(
    async (id) => {
      await api.acpHistoryDelete(id);
      void refreshHistory();
    },
    [refreshHistory],
  );

  return {
    agents,
    activeAgentId,
    setActiveAgentId,
    phase,
    session,
    authMethods,
    transcript,
    plan,
    commands,
    configOptions,
    usage,
    turnActive,
    history,
    shellContext,
    attachShellContext,
    clearShellContext,
    start,
    stop,
    reclaimAndStart,
    authenticate,
    resumeHistory,
    getHistoryRecord,
    deleteHistoryRecord,
    refreshHistory,
    sendPrompt,
    cancelTurn,
    setMode,
    setConfigOption,
    respondPermission,
    refreshAgents,
  };
}
