const THINK_BLOCK_PATTERN = /<think(?:\s[^>]*)?>([\s\S]*?)(?:<\/think>|$)/gi;
const STRAY_THINK_CLOSE_PATTERN = /<\/think>/gi;

const toText = (value) => (typeof value === "string" ? value : "");

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
  const content = toText(value);
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

export const groupOpsAgentMessages = (messages, options = {}) => {
  if (!Array.isArray(messages)) {
    return options?.isStreaming
      ? [
          {
            id: "__streaming__",
            kind: "agent_turn",
            messages: [],
            isStreaming: true,
            streamingText: toText(options?.streamingText),
          },
        ]
      : [];
  }

  const groups = [];
  let currentAgentTurn = null;

  messages.forEach((message, index) => {
    if (!message || typeof message !== "object") {
      return;
    }

    const messageId = typeof message.id === "string" && message.id.trim() ? message.id : `message-${index}`;

    if (message.role === "user") {
      currentAgentTurn = null;
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
        messages: [],
      };
      groups.push(currentAgentTurn);
    }

    currentAgentTurn.messages.push(message);
  });

  if (!options?.isStreaming) {
    return groups;
  }

  const streamingText = toText(options?.streamingText);
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const group = groups[index];
    if (!group || typeof group !== "object") {
      continue;
    }

    if (group.kind === "agent_turn") {
      const nextGroups = [...groups];
      nextGroups[index] = {
        ...group,
        isStreaming: true,
        streamingText,
      };
      return nextGroups;
    }

    if (group.kind === "user") {
      break;
    }
  }

  return [
    ...groups,
    {
      id: "__streaming__",
      kind: "agent_turn",
      messages: [],
      isStreaming: true,
      streamingText,
    },
  ];
};
