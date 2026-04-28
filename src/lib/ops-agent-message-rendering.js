const THINK_BLOCK_PATTERN = /<think(?:\s[^>]*)?>([\s\S]*?)(?:<\/think>|$)/gi;
const STRAY_THINK_CLOSE_PATTERN = /<\/think>/gi;
const MINIMAX_TOOL_CALL_PATTERN = /<minimax:tool_call(?:\s[^>]*)?>[\s\S]*?(?:<\/minimax:tool_call>|$)/gi;
const INVOKE_TOOL_CALL_PATTERN = /<invoke\b[\s\S]*?(?:<\/invoke>|$)/gi;
const STRAY_INTENT_TAG_PATTERN = /<\/?intent>/gi;

const toText = (value) => (typeof value === "string" ? value : "");
const toTimestamp = (value) => {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
};

const extractPlannerReplyFromJson = (value) => {
  const trimmed = toText(value).trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return null;
  }

  try {
    const payload = JSON.parse(trimmed);
    if (!payload || typeof payload !== "object" || !("tool" in payload) || !("reply" in payload)) {
      return null;
    }
    return toText(payload.reply).trim();
  } catch {
    return null;
  }
};

const sanitizePlannerArtifacts = (value) => {
  const jsonReply = extractPlannerReplyFromJson(value);
  if (jsonReply !== null) {
    return jsonReply;
  }

  return toText(value)
    .replace(MINIMAX_TOOL_CALL_PATTERN, "")
    .replace(INVOKE_TOOL_CALL_PATTERN, "")
    .replace(STRAY_INTENT_TAG_PATTERN, "")
    .trim();
};

const pushSegment = (segments, type, content) => {
  const normalized = toText(content).replace(STRAY_THINK_CLOSE_PATTERN, "");
  if (!normalized.trim()) {
    return;
  }

  segments.push({
    type,
    content: normalized.trim(),
  });
};

export const splitOpsAgentMessageContent = (value) => {
  const content = sanitizePlannerArtifacts(value);
  if (!content.trim()) {
    return [];
  }

  const segments = [];
  let lastIndex = 0;

  for (const match of content.matchAll(THINK_BLOCK_PATTERN)) {
    const start = match.index ?? 0;
    pushSegment(segments, "content", content.slice(lastIndex, start));
    pushSegment(segments, "think", match[1] || "");
    lastIndex = start + match[0].length;
  }

  pushSegment(segments, "content", content.slice(lastIndex));
  return segments;
};

export const getOpsAgentAssistantReplyText = (value) =>
  splitOpsAgentMessageContent(value)
    .filter((segment) => segment.type === "content")
    .map((segment) => segment.content)
    .join("\n\n")
    .trim();

export const getOpsAgentPreviewText = (value) => {
  const replyText = getOpsAgentAssistantReplyText(value);
  if (replyText) {
    return replyText.replace(/\s+/g, " ").trim();
  }

  const thoughtText = splitOpsAgentMessageContent(value)
    .filter((segment) => segment.type === "think")
    .map((segment) => segment.content)
    .join(" ");

  return thoughtText.replace(/\s+/g, " ").trim();
};

export const getOpsAgentLatestAssistantReplyText = (messages) => {
  if (!Array.isArray(messages)) {
    return "";
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant") {
      continue;
    }

    const replyText = getOpsAgentAssistantReplyText(message.content);
    if (replyText) {
      return replyText;
    }

    const thoughtText = splitOpsAgentMessageContent(message.content)
      .filter((segment) => segment.type === "think")
      .map((segment) => segment.content)
      .join("\n\n")
      .trim();

    if (thoughtText) {
      return thoughtText;
    }
  }

  return "";
};

const pendingActionToolState = (action) => {
  if (action?.status === "executed") {
    return "executed";
  }
  if (action?.status === "failed") {
    return "failed";
  }
  if (action?.status === "rejected") {
    return "rejected";
  }
  return "awaiting_approval";
};

const createPendingActionToolMessage = (action) => ({
  id: `pending-action:${action.id}`,
  role: "tool",
  content: toText(action.command),
  createdAt: toText(action.createdAt),
  toolKind: action.toolKind,
  toolState: pendingActionToolState(action),
  pendingAction: action,
});

const normalizeStreamingToolCalls = (toolCalls) => {
  if (!Array.isArray(toolCalls)) {
    return [];
  }

  return toolCalls
    .filter((toolCall) => toolCall && typeof toolCall === "object")
    .map((toolCall, index) => ({
      id:
        typeof toolCall.id === "string" && toolCall.id.trim()
          ? toolCall.id
          : `stream-tool-${index}`,
      role: "tool",
      content: toText(toolCall.command || toolCall.label),
      createdAt: toText(toolCall.createdAt),
      toolKind: toolCall.toolKind,
      toolState: typeof toolCall.status === "string" ? toolCall.status : "requested",
      toolCall,
    }));
};

const sortTurnMessages = (messages) =>
  messages
    .map((message, index) => ({ message, index }))
    .sort((left, right) => {
      const leftTimestamp = toTimestamp(left.message?.createdAt);
      const rightTimestamp = toTimestamp(right.message?.createdAt);
      if (leftTimestamp !== null && rightTimestamp !== null && leftTimestamp !== rightTimestamp) {
        return leftTimestamp - rightTimestamp;
      }
      return left.index - right.index;
    })
    .map((item) => item.message);

const ensureAgentTurnForPendingAction = (groups, action) => {
  const sourceUserMessageId =
    typeof action?.sourceUserMessageId === "string" && action.sourceUserMessageId.trim()
      ? action.sourceUserMessageId
      : "";
  if (sourceUserMessageId) {
    const existingTurnIndex = groups.findIndex(
      (group) => group.kind === "agent_turn" && group.sourceUserMessageId === sourceUserMessageId,
    );
    if (existingTurnIndex !== -1) {
      return existingTurnIndex;
    }

    const sourceUserIndex = groups.findIndex(
      (group) => group.kind === "user" && group.message?.id === sourceUserMessageId,
    );
    if (sourceUserIndex !== -1) {
      groups.splice(sourceUserIndex + 1, 0, {
        id: `pending-turn:${sourceUserMessageId}`,
        kind: "agent_turn",
        sourceUserMessageId,
        messages: [],
      });
      return sourceUserIndex + 1;
    }
  }

  const actionTimestamp = toTimestamp(action?.createdAt);
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const group = groups[index];
    if (group.kind !== "user") {
      continue;
    }

    const userTimestamp = toTimestamp(group.message?.createdAt);
    if (actionTimestamp && userTimestamp && userTimestamp > actionTimestamp) {
      continue;
    }

    if (groups[index + 1]?.kind === "agent_turn") {
      return index + 1;
    }

    groups.splice(index + 1, 0, {
      id: `pending-turn:${group.message?.id || index}`,
      kind: "agent_turn",
      sourceUserMessageId: group.message?.id || null,
      messages: [],
    });
    return index + 1;
  }

  if (groups[groups.length - 1]?.kind === "agent_turn") {
    return groups.length - 1;
  }

  groups.push({
    id: `pending-turn:${action?.id || groups.length}`,
    kind: "agent_turn",
    sourceUserMessageId: null,
    messages: [],
  });
  return groups.length - 1;
};

const injectPendingActionsIntoGroups = (groups, pendingActions, conversationId) => {
  if (!Array.isArray(pendingActions) || pendingActions.length === 0) {
    return groups;
  }

  const nextGroups = groups.map((group) =>
    group.kind === "agent_turn"
      ? {
          ...group,
          messages: [...group.messages],
        }
      : group,
  );

  pendingActions.forEach((action) => {
    if (!action || typeof action !== "object") {
      return;
    }
    if (conversationId && action.conversationId && action.conversationId !== conversationId) {
      return;
    }

    const targetIndex = ensureAgentTurnForPendingAction(nextGroups, action);
    const targetGroup = nextGroups[targetIndex];
    if (!targetGroup || targetGroup.kind !== "agent_turn") {
      return;
    }

    if (
      targetGroup.messages.some(
        (message) => message.pendingAction?.id === action.id || message.id === `pending-action:${action.id}`,
      )
    ) {
      return;
    }

    targetGroup.messages.push(createPendingActionToolMessage(action));
    targetGroup.messages = sortTurnMessages(targetGroup.messages);
  });

  return nextGroups;
};

export const groupOpsAgentMessages = (messages, options = {}) => {
  const streamingToolCalls = normalizeStreamingToolCalls(options?.streamingToolCalls);
  if (!Array.isArray(messages)) {
    return options?.isStreaming
      ? [
          {
            id: "__streaming__",
            kind: "agent_turn",
            sourceUserMessageId: null,
            messages: [],
            isStreaming: true,
            streamingText: toText(options?.streamingText),
            streamingToolCalls,
            streamingAgentProgress: options?.streamingAgentProgress || null,
          },
        ]
      : [];
  }

  const groups = [];
  let currentAgentTurn = null;
  let currentUserMessage = null;

  messages.forEach((message, index) => {
    if (!message || typeof message !== "object") {
      return;
    }

    const messageId = typeof message.id === "string" && message.id.trim() ? message.id : `message-${index}`;

    if (message.role === "user") {
      currentAgentTurn = null;
      currentUserMessage = message;
      groups.push({
        id: messageId,
        kind: "user",
        message,
      });
      return;
    }

    if (!currentAgentTurn) {
      currentAgentTurn = {
        id: `turn-${messageId}`,
        kind: "agent_turn",
        sourceUserMessageId: currentUserMessage?.id || null,
        messages: [],
      };
      groups.push(currentAgentTurn);
    }

    currentAgentTurn.messages.push(message);
  });

  const groupsWithPendingActions = injectPendingActionsIntoGroups(
    groups,
    options?.pendingActions,
    options?.conversationId,
  );

  if (!options?.isStreaming) {
    return groupsWithPendingActions;
  }

  const streamingText = toText(options?.streamingText);
  const streamingAgentProgress = options?.streamingAgentProgress || null;
  for (let index = groupsWithPendingActions.length - 1; index >= 0; index -= 1) {
    const group = groupsWithPendingActions[index];
    if (!group || typeof group !== "object") {
      continue;
    }

    if (group.kind === "agent_turn") {
      const nextGroups = [...groupsWithPendingActions];
      nextGroups[index] = {
        ...group,
        isStreaming: true,
        streamingText,
        streamingToolCalls,
        streamingAgentProgress,
      };
      return nextGroups;
    }

    if (group.kind === "user") {
      break;
    }
  }

  return [
    ...groupsWithPendingActions,
    {
      id: "__streaming__",
      kind: "agent_turn",
      sourceUserMessageId: currentUserMessage?.id || null,
      messages: [],
      isStreaming: true,
      streamingText,
      streamingToolCalls,
      streamingAgentProgress,
    },
  ];
};
