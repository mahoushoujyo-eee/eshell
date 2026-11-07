import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { normalizeShellContextAttachment } from "../lib/ops-agent-shell-context";
import { api } from "../lib/tauri-api";

/**
 * Multi-conversation state machine for the ACP panel.
 *
 * One agent subprocess can host several conversations at once (measured with
 * `scripts/acp-concurrency-probe.mjs`: two `session/new` on one connection run
 * their turns concurrently and `session/close` really releases them). The state
 * is therefore a list of conversations, each with its own transcript, plan,
 * config options, usage, turn state and composer draft — plus one `activeKey`
 * pointing at the one the panel is showing.
 *
 * Why this shape: the previous single-session model forced every switch (new
 * conversation, different agent, reopening history) to stop the whole process
 * first, which lost the live conversation and cost a full handshake. Nothing
 * in the protocol required that.
 *
 * Conversation entries:
 * - { id, type: "user", text, images?, context? }  — context: attached terminal selection
 * - { id, type: "assistant", text }               — streamed, merged per segment
 * - { id, type: "thought", text }                 — agent reasoning, merged per segment
 * - { id, type: "tool", tool }                    — updated in place by toolCallId
 * - { id, type: "permission", requestId, toolCall, options, resolution, resolving }
 * - { id, type: "notice", tone, code, detail }    — codes translated by the panel
 *
 * Stream events carry both `agentId` and `sessionId`; `sessionId` routes an
 * update to its conversation. The one exception is `stopped`, which is
 * connection-scoped: its `sessionId` is whichever session the backend last
 * created, so it must be routed by `agentId` and it ends every conversation of
 * that agent.
 */

const STREAM_EVENT = "acp-agent-stream";
const HISTORY_TITLE_LENGTH = 48;

// A failing command often surfaces twice: the command's own rejection and the
// stream event that reports the same outage. Inside this window the second
// one is noise, so it is swallowed.
const FAILURE_DEDUPE_MS = 5000;

let entrySeq = 0;
const nextEntryId = () => {
  entrySeq += 1;
  return `acp-entry-${entrySeq}`;
};

// Local conversation id. Deliberately not the agent's session id: a
// conversation exists (in "starting") before the agent has created it, and a
// failed start or an ended conversation still keeps its place in the list.
let conversationSeq = 0;
const nextConversationKey = () => {
  conversationSeq += 1;
  return `c${conversationSeq}`;
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

const emptyDraft = () => ({ text: "", attachments: [], shellContext: null });

const titleFromTranscript = (transcript) => {
  const firstUser = transcript.find((entry) => entry.type === "user");
  return firstUser ? String(firstUser.text || "").replaceAll("\n", " ").slice(0, HISTORY_TITLE_LENGTH) : "";
};

export function useAcpAgent() {
  const [agents, setAgents] = useState([]);
  // Agent used by the "new conversation" entry point; no longer a property of
  // the panel as a whole, because every conversation carries its own agent.
  const [activeAgentId, setActiveAgentId] = useState(null);
  const [conversations, setConversations] = useState([]);
  const [activeKey, setActiveKey] = useState(null);
  const [history, setHistory] = useState([]);
  // Local directories ACP sessions can run in ({id, name, path, createdAt}).
  const [projects, setProjects] = useState([]);
  // Node.js toolchain probe result ({ ok, node, npx }); null until probed.
  const [runtimeEnv, setRuntimeEnv] = useState(null);
  // Failures that happen with no conversation to attach them to (project
  // registry errors, mostly). Rendered above the empty state.
  const [standaloneNotices, setStandaloneNotices] = useState([]);

  const conversationsRef = useRef(conversations);
  conversationsRef.current = conversations;
  const activeKeyRef = useRef(activeKey);
  activeKeyRef.current = activeKey;
  const agentsRef = useRef(agents);
  agentsRef.current = agents;
  const activeAgentIdRef = useRef(activeAgentId);
  activeAgentIdRef.current = activeAgentId;

  // A terminal selection made while every conversation is closed rides along
  // into the next conversation the user opens.
  const pendingShellContextRef = useRef(null);
  // One start chain per agent: `acp_agent_start` refuses when that agent
  // already has a live runner, so two quick "new conversation" clicks would
  // otherwise race into `already has an active session`.
  const startQueuesRef = useRef(new Map());
  // Agents this hook has a live process for. `agents[].running` comes from an
  // async list refresh that may not have landed yet when the next conversation
  // starts; without this, the second click would take the `acp_agent_start`
  // path and fail on a process that is already running.
  const liveAgentsRef = useRef(new Set());
  const failureReportedAtRef = useRef(0);

  /** Applies a patch to one conversation. */
  const patchConversation = useCallback((key, patch) => {
    setConversations((prev) =>
      prev.map((conversation) =>
        conversation.key === key ? { ...conversation, ...patch } : conversation,
      ),
    );
  }, []);

  /** Functional update for one conversation (append to transcript, etc.). */
  const updateConversation = useCallback((key, updater) => {
    setConversations((prev) =>
      prev.map((conversation) =>
        conversation.key === key ? updater(conversation) : conversation,
      ),
    );
  }, []);

  // sessionId -> conversation key, and agentId -> its conversation keys. The
  // stream listener reads these through a ref, so it stays registered once.
  const routing = useMemo(() => {
    const bySession = new Map();
    const byAgent = new Map();
    for (const conversation of conversations) {
      if (conversation.sessionId) {
        bySession.set(conversation.sessionId, conversation.key);
      }
      const keys = byAgent.get(conversation.agentId) || [];
      keys.push(conversation.key);
      byAgent.set(conversation.agentId, keys);
    }
    return { bySession, byAgent };
  }, [conversations]);
  const routingRef = useRef(routing);
  routingRef.current = routing;

  /* ---------------------------------------------------------------- notices */

  const pushNotice = useCallback(
    (tone, code, detail = "", key = null) => {
      const entry = {
        id: nextEntryId(),
        type: "notice",
        tone,
        code,
        detail: String(detail || ""),
      };
      const targetKey =
        key ||
        activeKeyRef.current ||
        conversationsRef.current[conversationsRef.current.length - 1]?.key ||
        null;
      if (!targetKey) {
        setStandaloneNotices((prev) => [...prev, entry]);
        return;
      }
      updateConversation(targetKey, (conversation) => ({
        ...conversation,
        transcript: [...conversation.transcript, entry],
      }));
    },
    [updateConversation],
  );

  const reportFailure = useCallback(
    (code, err, key = null) => {
      pushNotice("error", code, err, key);
      failureReportedAtRef.current = Date.now();
    },
    [pushNotice],
  );

  const failureAlreadyReported = useCallback(
    () => Date.now() - failureReportedAtRef.current < FAILURE_DEDUPE_MS,
    [],
  );

  /* ------------------------------------------------------------- transcript */

  const appendStreamText = useCallback(
    (key, type, chunk) => {
      if (typeof chunk !== "string" || chunk.length === 0) {
        return;
      }
      const background = key !== activeKeyRef.current;
      updateConversation(key, (conversation) => {
        const last = conversation.transcript[conversation.transcript.length - 1];
        if (last && last.type === type) {
          const transcript = conversation.transcript.slice(0, -1);
          transcript.push({ ...last, text: last.text + chunk });
          return { ...conversation, transcript };
        }
        // A new segment of agent text on a background conversation is what the
        // tab's unread dot is counting.
        const unread = background && type === "assistant" ? conversation.unread + 1 : conversation.unread;
        return {
          ...conversation,
          unread,
          transcript: [...conversation.transcript, { id: nextEntryId(), type, text: chunk }],
        };
      });
    },
    [updateConversation],
  );

  const mergeToolCall = useCallback(
    (key, view) => {
      if (!view || !view.toolCallId) {
        return;
      }
      updateConversation(key, (conversation) => {
        const index = conversation.transcript.findIndex(
          (entry) => entry.type === "tool" && entry.tool.toolCallId === view.toolCallId,
        );
        if (index === -1) {
          return {
            ...conversation,
            transcript: [
              ...conversation.transcript,
              { id: nextEntryId(), type: "tool", tool: normalizeTool(view) },
            ],
          };
        }
        const transcript = [...conversation.transcript];
        transcript[index] = {
          ...transcript[index],
          tool: mergeToolView(transcript[index].tool, view),
        };
        return { ...conversation, transcript };
      });
    },
    [updateConversation],
  );

  const resolvePermissionEntry = useCallback(
    (key, resolution) => {
      if (!resolution || !resolution.requestId) {
        return;
      }
      updateConversation(key, (conversation) => ({
        ...conversation,
        transcript: conversation.transcript.map((entry) =>
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
      }));
    },
    [updateConversation],
  );

  /* ----------------------------------------------------------------- agents */

  const refreshAgents = useCallback(async () => {
    try {
      const rows = await api.acpAgentList();
      if (Array.isArray(rows)) {
        setAgents(rows);
        // The list is the authority on which processes are alive.
        liveAgentsRef.current = new Set(rows.filter((row) => row.running).map((row) => row.id));
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

  const refreshProjects = useCallback(async () => {
    try {
      const rows = await api.acpProjectList();
      if (Array.isArray(rows)) {
        setProjects(rows);
      }
    } catch {
      // Same deal as history: an unreadable registry shows as "no projects".
    }
  }, []);

  useEffect(() => {
    void refreshAgents();
    void refreshHistory();
    void refreshProjects();
  }, [refreshAgents, refreshHistory, refreshProjects]);

  /* ------------------------------------------------------------ runtime env */

  const missingEnvTools = (env) =>
    !env || env.ok
      ? []
      : [env.node, env.npx].filter((tool) => tool && !tool.found).map((tool) => tool.command);

  // Last probe conclusion, so the notice is pushed on the transition only.
  const lastEnvOkRef = useRef(null);

  const refreshRuntimeEnv = useCallback(async () => {
    let env = null;
    try {
      const probed = await api.acpRuntimeEnv();
      env = probed && typeof probed === "object" ? probed : null;
    } catch {
      setRuntimeEnv(null);
      return null;
    }
    setRuntimeEnv(env);
    // Only on the transition into missing: otherwise every panel open would
    // push another identical notice.
    if (env && !env.ok && lastEnvOkRef.current !== false) {
      pushNotice("warning", "env-missing", missingEnvTools(env).join(", "));
    }
    lastEnvOkRef.current = Boolean(env?.ok);
    return env;
  }, [pushNotice]);

  /* --------------------------------------------------------------- history */

  /** Persists one conversation's transcript under its agent session id. */
  const saveHistoryFor = useCallback(
    async (conversation) => {
      if (!conversation?.sessionId || !conversation?.agentId) {
        return;
      }
      const title = titleFromTranscript(conversation.transcript);
      if (!title) {
        return;
      }
      try {
        await api.acpHistorySave({
          id: conversation.sessionId,
          agentId: conversation.agentId,
          agentName: conversation.agentName || conversation.agentId,
          title,
          createdAt: conversation.createdAt || "",
          updatedAt: "",
          projectId: conversation.projectId ?? null,
          cwd: conversation.cwd ?? null,
          transcript: sanitizeEntriesForHistory(conversation.transcript),
        });
        void refreshHistory();
      } catch {
        // Persistence is best-effort; the live conversation is unaffected.
      }
    },
    [refreshHistory],
  );

  /* ----------------------------------------------------------- conversation */

  const frameConversation = useCallback(
    (agentId, { project = null, resume = null } = {}) => {
      const agentName = agentsRef.current.find((agent) => agent.id === agentId)?.name || agentId;
      return {
        key: nextConversationKey(),
        agentId,
        agentName,
        sessionId: null,
        phase: "starting",
        cwd: project?.path ?? resume?.cwd ?? null,
        projectId: project?.id ?? resume?.projectId ?? null,
        transcript: [],
        plan: null,
        commands: [],
        configOptions: [],
        usage: null,
        modes: null,
        authMethods: [],
        agentInfo: null,
        capabilities: null,
        turnActive: false,
        unread: 0,
        ended: false,
        failed: false,
        resumeRequested: Boolean(resume?.id),
        draft: { ...emptyDraft(), shellContext: pendingShellContextRef.current },
        title: resume?.title ?? "",
        createdAt: new Date().toISOString(),
      };
    },
    [],
  );

  const applyStartInfo = useCallback(
    (key, info, project) => {
      updateConversation(key, (conversation) => ({
        ...conversation,
        sessionId: info.sessionId,
        phase: "ready",
        modes: info.modes || null,
        agentInfo: info.agentInfo || null,
        capabilities: info.capabilities || null,
        configOptions: Array.isArray(info.configOptions) ? info.configOptions : [],
        cwd: project?.path ?? info.cwd ?? conversation.cwd,
        projectId: project?.id ?? conversation.projectId,
        authMethods: [],
        ended: false,
        failed: false,
      }));
      void refreshAgents();
    },
    [refreshAgents, updateConversation],
  );

  /**
   * Creates the agent-side session for one conversation, reusing the running
   * process when there is one and spawning only when there is not. Runs inside
   * the per-agent start chain.
   */
  const startInto = useCallback(
    async (key, agentId, { project = null, resume = null } = {}) => {
      const agentRunning =
        liveAgentsRef.current.has(agentId) ||
        agentsRef.current.find((agent) => agent.id === agentId)?.running === true;
      const resumeId = resume?.id && resume.agentId === agentId ? resume.id : null;
      try {
        let info;
        if (agentRunning) {
          if (resumeId) {
            try {
              info = await api.acpSessionLoad(agentId, resumeId, resume.cwd ?? null);
            } catch {
              // The agent no longer knows this conversation (pruned history,
              // different host). Open a fresh one in the same folder and say
              // so, rather than leaving the tab blank.
              info = await api.acpSessionNew(agentId, resume.cwd ?? project?.path ?? null);
              pushNotice("info", "resume-fallback", "", key);
            }
          } else {
            info = await api.acpSessionNew(agentId, project?.path ?? null);
          }
        } else {
          try {
            info = await api.acpAgentStart(
              agentId,
              resumeId,
              project?.path ?? resume?.cwd ?? null,
            );
          } catch (err) {
            // The list said no process, but one is alive (a runner started
            // outside this window, or a refresh that raced the start). Reuse it
            // instead of surfacing "already has an active session".
            if (/already has an active session/i.test(String(err))) {
              info = await api.acpSessionNew(
                agentId,
                project?.path ?? resume?.cwd ?? null,
              );
              liveAgentsRef.current.add(agentId);
            } else {
              throw err;
            }
          }
        }

        if (info?.authRequired) {
          // The process is up but parked waiting for sign-in: it is live, and
          // the next conversation must reuse it rather than spawn again.
          liveAgentsRef.current.add(agentId);
          updateConversation(key, (conversation) => ({
            ...conversation,
            phase: "auth",
            authMethods: Array.isArray(info.authMethods) ? info.authMethods : [],
            capabilities: info.capabilities || conversation.capabilities,
          }));
          return;
        }

        applyStartInfo(key, info, project);
        liveAgentsRef.current.add(agentId);
      } catch (err) {
        updateConversation(key, (conversation) => ({
          ...conversation,
          phase: "ended",
          ended: true,
          failed: true,
          turnActive: false,
        }));
        reportFailure("start-failed", err, key);
        // The failure may be "this agent already has an active session"; the
        // refreshed `running` flag is what makes the retry path work.
        void refreshAgents();
      }
    },
    [applyStartInfo, pushNotice, refreshAgents, reportFailure, updateConversation],
  );

  const enqueueAgentStart = useCallback((agentId, task) => {
    const previous = startQueuesRef.current.get(agentId) || Promise.resolve();
    const next = previous.then(task, task);
    startQueuesRef.current.set(agentId, next.then(
      () => {},
      () => {},
    ));
    return next;
  }, []);

  /**
   * Opens one conversation and makes it active. Never stops anything: another
   * conversation of the same agent simply keeps running alongside.
   */
  const openSession = useCallback(
    async ({ agentId = null, project = null, resume = null } = {}) => {
      const targetAgent =
        agentId || activeAgentIdRef.current || agentsRef.current[0]?.id || null;
      if (!targetAgent) {
        return null;
      }
      const conversation = frameConversation(targetAgent, { project, resume });
      pendingShellContextRef.current = null;
      setConversations((prev) => [...prev, conversation]);
      setActiveKey(conversation.key);
      await enqueueAgentStart(targetAgent, () =>
        startInto(conversation.key, targetAgent, { project, resume }),
      );
      return conversation.key;
    },
    [enqueueAgentStart, frameConversation, startInto],
  );

  /**
   * Ends one conversation and drops its tab. The agent process is stopped only
   * once its last conversation is gone, so closing one tab never takes the
   * others down with it.
   */
  const closeSession = useCallback(
    async (key) => {
      const conversation = conversationsRef.current.find((row) => row.key === key);
      if (!conversation) {
        return;
      }
      await saveHistoryFor(conversation);
      if (conversation.sessionId && !conversation.ended) {
        try {
          await api.acpSessionClose(conversation.agentId, conversation.sessionId);
        } catch {
          // The process may already be gone; the tab is removed either way.
        }
      }
      const remaining = conversationsRef.current.filter((row) => row.key !== key);
      setConversations(remaining);
      setActiveKey((current) => {
        if (current !== key) {
          return current;
        }
        const sameAgent = remaining.filter((row) => row.agentId === conversation.agentId);
        return (sameAgent[sameAgent.length - 1] || remaining[remaining.length - 1])?.key ?? null;
      });
      if (!remaining.some((row) => row.agentId === conversation.agentId)) {
        try {
          await api.acpAgentStop(conversation.agentId);
        } catch {
          // Stopping an already-dead process is not an error worth a notice.
        }
        liveAgentsRef.current.delete(conversation.agentId);
        void refreshAgents();
      }
    },
    [refreshAgents, saveHistoryFor],
  );

  /** Marks every conversation of one agent as ended (process stopped/crashed). */
  const endAgentConversations = useCallback(
    (agentId, error) => {
      const rows = conversationsRef.current.filter((row) => row.agentId === agentId);
      liveAgentsRef.current.delete(agentId);
      if (rows.length === 0) {
        return false;
      }
      // A tab that was already ended needs no second "session ended" line.
      const wasLive = rows.some((row) => row.phase !== "ended");
      const keys = new Set(rows.map((row) => row.key));
      setConversations((prev) =>
        prev.map((conversation) =>
          keys.has(conversation.key)
            ? {
                ...conversation,
                phase: "ended",
                ended: true,
                turnActive: false,
                authMethods: [],
              }
            : conversation,
        ),
      );
      const target =
        rows.find((row) => row.key === activeKeyRef.current) || rows[rows.length - 1];
      if (error) {
        // The command's own rejection usually reported this already.
        if (!failureAlreadyReported()) {
          reportFailure("agent-error", error, target.key);
        }
      } else if (wasLive) {
        pushNotice("info", "session-ended", "", target.key);
      }
      void refreshAgents();
      return true;
    },
    [failureAlreadyReported, pushNotice, refreshAgents, reportFailure],
  );

  /* -------------------------------------------------------------- streaming */

  useEffect(() => {
    const unlistenPromise = listen(STREAM_EVENT, (event) => {
      const payload = event?.payload;
      if (!payload || typeof payload !== "object") {
        return;
      }
      const { agentId, stage } = payload;

      // Connection-scoped, and its `sessionId` is whatever the backend last
      // established — never trust it for routing.
      if (stage === "stopped") {
        endAgentConversations(agentId, payload.error);
        return;
      }

      const route = routingRef.current;
      let key = route.bySession.get(payload.sessionId) || null;
      if (!key) {
        // Handshake-phase events (a `session/load` replay, the initial
        // available-commands push) can arrive before the start call has
        // returned the session id. Starts are serialised per agent, so at most
        // one conversation of that agent is still starting.
        const starting = conversationsRef.current.find(
          (conversation) => conversation.agentId === agentId && conversation.phase === "starting",
        );
        key = starting?.key ?? null;
      }
      if (!key) {
        return;
      }

      switch (stage) {
        case "delta":
          appendStreamText(key, "assistant", payload.chunk);
          break;
        case "thought":
          appendStreamText(key, "thought", payload.chunk);
          break;
        case "user":
          // User chunks only arrive as `session/load` replay (during start);
          // live turns already pushed the entry locally.
          appendStreamText(key, "user", payload.chunk);
          break;
        case "tool_call":
        case "tool_call_update":
          mergeToolCall(key, payload.toolCall);
          break;
        case "plan":
          patchConversation(key, { plan: Array.isArray(payload.plan) ? payload.plan : [] });
          break;
        case "commands":
          patchConversation(key, {
            commands: Array.isArray(payload.commands) ? payload.commands : [],
          });
          break;
        case "config_options":
          patchConversation(key, {
            configOptions: Array.isArray(payload.configOptions) ? payload.configOptions : [],
          });
          break;
        case "mode":
          if (payload.currentModeId) {
            updateConversation(key, (conversation) => ({
              ...conversation,
              modes: {
                availableModes: conversation.modes?.availableModes || [],
                currentModeId: payload.currentModeId,
              },
            }));
          }
          break;
        case "usage":
          patchConversation(key, { usage: payload.usage || null });
          break;
        case "permission_request":
          if (payload.permission?.requestId) {
            updateConversation(key, (conversation) => ({
              ...conversation,
              transcript: [
                ...conversation.transcript,
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
              ],
            }));
          }
          break;
        case "permission_resolved":
          resolvePermissionEntry(key, payload.permissionResolution);
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
    endAgentConversations,
    mergeToolCall,
    patchConversation,
    resolvePermissionEntry,
    updateConversation,
  ]);

  /* --------------------------------------------------------------- projects */

  // Registers a directory picked in the OS folder dialog. The backend rejects
  // non-directories and returns the existing entry for a duplicate path.
  const createProject = useCallback(
    async (path) => {
      try {
        const project = await api.acpProjectCreate(path);
        await refreshProjects();
        return project;
      } catch (err) {
        reportFailure("project-create-failed", err);
        return null;
      }
    },
    [refreshProjects, reportFailure],
  );

  // "New project" flow: OS folder picker, then register the chosen directory.
  // A cancelled dialog returns null and registers nothing.
  const addProject = useCallback(async () => {
    try {
      const path = await api.selectDirectory();
      if (!path) {
        return null;
      }
      return await createProject(path);
    } catch (err) {
      reportFailure("project-create-failed", err);
      return null;
    }
  }, [createProject, reportFailure]);

  // Removes the project entry only; its transcripts survive as ungrouped
  // sessions, which is what the backend does too.
  const deleteProject = useCallback(
    async (id) => {
      try {
        await api.acpProjectDelete(id);
        await refreshProjects();
      } catch (err) {
        reportFailure("project-delete-failed", err);
      }
    },
    [refreshProjects, reportFailure],
  );

  /* ---------------------------------------------------------------- actions */

  const start = useCallback(
    () => openSession({ agentId: activeAgentIdRef.current }),
    [openSession],
  );

  const startSession = useCallback(
    ({ agentId = null, project = null } = {}) =>
      openSession({ agentId: agentId || activeAgentIdRef.current, project }),
    [openSession],
  );

  // "New conversation" in the panel header: same agent and folder as the
  // conversation in front of the user, because that is the context they are in.
  const newSession = useCallback(() => {
    const current =
      conversationsRef.current.find((row) => row.key === activeKeyRef.current) || null;
    return openSession({
      agentId: current?.agentId ?? activeAgentIdRef.current,
      project: current
        ? { id: current.projectId ?? null, path: current.cwd ?? null }
        : null,
    });
  }, [openSession]);

  const resumeHistory = useCallback(
    (record) => {
      if (!record?.id || !record?.agentId) {
        return null;
      }
      // Already open in another tab: focus it instead of opening a duplicate.
      const open = conversationsRef.current.find(
        (row) => row.agentId === record.agentId && row.sessionId === record.id,
      );
      if (open) {
        setActiveKey(open.key);
        return Promise.resolve(open.key);
      }
      return openSession({ agentId: record.agentId, resume: record });
    },
    [openSession],
  );

  // Stops an agent process: the explicit form reclaims an orphaned backend
  // runner left behind by a reload, and each conversation of that agent becomes
  // an ended tab rather than disappearing.
  const stop = useCallback(
    async (agentId = null) => {
      const targetId =
        agentId ||
        conversationsRef.current.find((row) => row.key === activeKeyRef.current)?.agentId ||
        activeAgentIdRef.current;
      if (!targetId) {
        return;
      }
      try {
        await api.acpAgentStop(targetId);
        // The `stopped` stream event normally ends the tabs; doing it here too
        // keeps a stop from an unengaged agent (whose event is dropped by the
        // backend) from leaving them "ready" forever.
        endAgentConversations(targetId, null);
      } catch (err) {
        reportFailure("agent-error", err);
      }
    },
    [endAgentConversations, reportFailure],
  );

  // Reclaims an orphaned runner and immediately opens a fresh conversation.
  const reclaimAndStart = useCallback(
    async (agentId) => {
      const targetId = agentId || activeAgentIdRef.current;
      if (!targetId) {
        return;
      }
      await stop(targetId);
      await openSession({ agentId: targetId });
    },
    [openSession, stop],
  );

  const authenticate = useCallback(
    async (methodId) => {
      const key = activeKeyRef.current;
      const conversation = conversationsRef.current.find((row) => row.key === key);
      if (!conversation || !methodId) {
        return;
      }
      patchConversation(key, { phase: "authenticating" });
      try {
        const info = await api.acpAgentAuthenticate(conversation.agentId, methodId);
        applyStartInfo(key, info, null);
      } catch (err) {
        // The agent may have died mid sign-in; `stopped` already ended the tab.
        if (conversationsRef.current.some((row) => row.key === key && !row.ended)) {
          patchConversation(key, { phase: "auth" });
          reportFailure("auth-failed", err, key);
        }
      }
    },
    [applyStartInfo, patchConversation, reportFailure],
  );

  const sendPrompt = useCallback(
    async (text, images = []) => {
      const key = activeKeyRef.current;
      const conversation = conversationsRef.current.find((row) => row.key === key);
      if (!conversation || conversation.phase !== "ready" || !conversation.sessionId) {
        return false;
      }
      const trimmed = String(text || "").trim();
      const attachments = Array.isArray(images) ? images : [];
      const context = conversation.draft?.shellContext ?? null;
      if ((!trimmed && attachments.length === 0 && !context) || conversation.turnActive) {
        return false;
      }
      // The staged terminal selection travels as a fenced block appended to
      // the typed text; the transcript keeps it structured for rendering.
      const outgoing = context
        ? `${trimmed}${trimmed ? "\n\n" : ""}Terminal selection from "${context.sessionName}":\n\`\`\`\n${context.content}\n\`\`\``
        : trimmed;
      updateConversation(key, (row) => ({
        ...row,
        turnActive: true,
        draft: { ...emptyDraft() },
        transcript: [
          ...row.transcript,
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
        ],
      }));
      try {
        const result = await api.acpSessionPrompt(
          conversation.agentId,
          conversation.sessionId,
          outgoing,
          attachments.map((image) => ({ data: image.data, mimeType: image.mimeType })),
        );
        const stopReason = result?.stopReason;
        if (stopReason && stopReason !== "end_turn") {
          pushNotice("info", "turn-stopped", stopReason, key);
        }
      } catch (err) {
        // A stop that raced the prompt already reported through `stopped`.
        if (conversationsRef.current.some((row) => row.key === key && !row.ended)) {
          reportFailure("turn-failed", err, key);
        }
      } finally {
        updateConversation(key, (row) => ({ ...row, turnActive: false }));
        const saved = conversationsRef.current.find((row) => row.key === key) || conversation;
        void saveHistoryFor(saved);
      }
      return true;
    },
    [pushNotice, reportFailure, saveHistoryFor, updateConversation],
  );

  const cancelTurn = useCallback(async () => {
    const conversation = conversationsRef.current.find((row) => row.key === activeKeyRef.current);
    if (!conversation?.sessionId) {
      return;
    }
    try {
      await api.acpSessionCancel(conversation.agentId, conversation.sessionId);
    } catch {
      // Cancellation is best-effort; prompt settling clears the turn state.
    }
  }, []);

  const setMode = useCallback(
    async (modeId) => {
      const key = activeKeyRef.current;
      const conversation = conversationsRef.current.find((row) => row.key === key);
      if (!conversation?.sessionId || !modeId) {
        return;
      }
      const previousModeId = conversation.modes?.currentModeId ?? null;
      updateConversation(key, (row) => ({
        ...row,
        modes: { availableModes: row.modes?.availableModes || [], currentModeId: modeId },
      }));
      try {
        await api.acpSessionSetMode(conversation.agentId, conversation.sessionId, modeId);
      } catch (err) {
        if (previousModeId) {
          updateConversation(key, (row) => ({
            ...row,
            modes: { availableModes: row.modes?.availableModes || [], currentModeId: previousModeId },
          }));
        }
        reportFailure("mode-failed", err, key);
      }
    },
    [reportFailure, updateConversation],
  );

  // Applies one config option. The agent answers with the full updated set, so
  // the reply is authoritative — no optimistic merge, and a failure leaves the
  // previous set untouched.
  const setConfigOption = useCallback(
    async (configId, value) => {
      const key = activeKeyRef.current;
      const conversation = conversationsRef.current.find((row) => row.key === key);
      if (!conversation?.sessionId || !configId) {
        return;
      }
      try {
        const updated = await api.acpSessionSetConfigOption(
          conversation.agentId,
          conversation.sessionId,
          configId,
          value,
        );
        if (Array.isArray(updated)) {
          patchConversation(key, { configOptions: updated });
        }
      } catch (err) {
        reportFailure("config-option-failed", err, key);
      }
    },
    [patchConversation, reportFailure],
  );

  const respondPermission = useCallback(
    async (requestId, optionId) => {
      const key = activeKeyRef.current;
      const conversation = conversationsRef.current.find((row) => row.key === key);
      if (!conversation?.sessionId || !requestId) {
        return;
      }
      updateConversation(key, (row) => ({
        ...row,
        transcript: row.transcript.map((entry) =>
          entry.type === "permission" && entry.requestId === requestId
            ? { ...entry, resolving: true }
            : entry,
        ),
      }));
      try {
        await api.acpPermissionRespond(conversation.agentId, requestId, optionId ?? null);
        resolvePermissionEntry(key, {
          requestId,
          optionId: optionId ?? null,
          cancelled: optionId == null,
        });
      } catch (err) {
        updateConversation(key, (row) => ({
          ...row,
          transcript: row.transcript.map((entry) =>
            entry.type === "permission" && entry.requestId === requestId
              ? { ...entry, resolving: false }
              : entry,
          ),
        }));
        reportFailure("permission-failed", err, key);
      }
    },
    [reportFailure, resolvePermissionEntry, updateConversation],
  );

  /* ----------------------------------------------------------------- drafts */

  const setDraft = useCallback((patch) => {
    const key = activeKeyRef.current;
    if (!key) {
      return;
    }
    updateConversation(key, (row) => ({ ...row, draft: { ...row.draft, ...patch } }));
  }, [updateConversation]);

  // Stages a terminal selection as context for the next prompt (replaces any
  // previously staged selection, mirroring the legacy assistant behavior).
  const attachShellContext = useCallback(
    (selection) => {
      const normalized = normalizeShellContextAttachment(selection);
      if (!normalized) {
        return;
      }
      const key = activeKeyRef.current;
      if (!key) {
        pendingShellContextRef.current = normalized;
        return;
      }
      updateConversation(key, (row) => ({
        ...row,
        draft: { ...row.draft, shellContext: normalized },
      }));
    },
    [updateConversation],
  );

  const clearShellContext = useCallback(() => {
    const key = activeKeyRef.current;
    if (!key) {
      pendingShellContextRef.current = null;
      return;
    }
    updateConversation(key, (row) => ({ ...row, draft: { ...row.draft, shellContext: null } }));
  }, [updateConversation]);

  // Reading a conversation clears its unread dot.
  useEffect(() => {
    if (!activeKey) {
      return;
    }
    updateConversation(activeKey, (row) => (row.unread === 0 ? row : { ...row, unread: 0 }));
  }, [activeKey, updateConversation]);

  const getHistoryRecord = useCallback(async (id) => api.acpHistoryGet(id), []);

  const deleteHistoryRecord = useCallback(
    async (id) => {
      await api.acpHistoryDelete(id);
      void refreshHistory();
    },
    [refreshHistory],
  );

  /* ---------------------------------------------------------------- surface */

  const activeConversation = useMemo(
    () => conversations.find((row) => row.key === activeKey) || null,
    [conversations, activeKey],
  );

  // Any conversation working, for the dock/title-bar busy indicator. The
  // per-conversation flag stays on the conversation itself, because the
  // composer's send-vs-stop button belongs to one conversation only.
  const anyTurnActive = useMemo(
    () => conversations.some((row) => row.turnActive),
    [conversations],
  );

  // The panel still reads the single-conversation fields: they mirror whichever
  // tab is in front. `sessions` / `activeKey` are what the tab strip uses.
  const session = useMemo(
    () =>
      activeConversation
        ? {
            agentId: activeConversation.agentId,
            agentName: activeConversation.agentName,
            id: activeConversation.sessionId,
            modes: activeConversation.modes,
            agentInfo: activeConversation.agentInfo,
            capabilities: activeConversation.capabilities,
            projectId: activeConversation.projectId,
            cwd: activeConversation.cwd,
            createdAt: activeConversation.createdAt,
          }
        : null,
    [activeConversation],
  );

  return {
    // Multi-conversation surface.
    conversations,
    activeKey,
    setActiveKey,
    activeConversation,
    openSession,
    closeSession,
    stopAgent: stop,

    // Derived single-conversation surface (the tab in front).
    agents,
    activeAgentId,
    setActiveAgentId,
    phase: activeConversation?.phase ?? "idle",
    session,
    authMethods: activeConversation?.authMethods ?? [],
    transcript: activeConversation?.transcript ?? [],
    plan: activeConversation?.plan ?? null,
    commands: activeConversation?.commands ?? [],
    configOptions: activeConversation?.configOptions ?? [],
    usage: activeConversation?.usage ?? null,
    turnActive: activeConversation?.turnActive ?? false,
    anyTurnActive,
    draft: activeConversation?.draft ?? emptyDraft(),
    standaloneNotices,

    history,
    projects,
    refreshProjects,
    createProject,
    addProject,
    deleteProject,
    shellContext: activeConversation?.draft?.shellContext ?? null,
    attachShellContext,
    clearShellContext,
    setDraft,
    start,
    startSession,
    stop,
    reclaimAndStart,
    newSession,
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
    runtimeEnv,
    envMissing: runtimeEnv != null && !runtimeEnv.ok,
    refreshRuntimeEnv,
  };
}
