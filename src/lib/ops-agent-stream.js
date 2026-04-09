export const EMPTY_OPS_AGENT_STREAM = Object.freeze({
  runId: null,
  conversationId: null,
  text: "",
  toolCalls: [],
});

export const upsertOpsAgentPendingAction = (rows, nextAction) => {
  if (!nextAction?.id) {
    return rows;
  }

  const index = rows.findIndex((item) => item.id === nextAction.id);
  if (index === -1) {
    return [nextAction, ...rows];
  }

  const next = [...rows];
  next[index] = nextAction;
  return next;
};

export const normalizeOpsAgentStreamEvent = (payload) => {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const stage = typeof payload.stage === "string" ? payload.stage : "";
  if (!stage) {
    return null;
  }

  return {
    runId: typeof payload.runId === "string" ? payload.runId : "",
    conversationId: typeof payload.conversationId === "string" ? payload.conversationId : "",
    stage,
    chunk: typeof payload.chunk === "string" ? payload.chunk : "",
    createdAt: typeof payload.createdAt === "string" ? payload.createdAt : "",
    errorMessage: typeof payload.error === "string" ? payload.error : "",
    toolCall:
      payload.toolCall && typeof payload.toolCall === "object"
        ? payload.toolCall
        : null,
    pendingAction:
      payload.pendingAction && typeof payload.pendingAction === "object"
        ? payload.pendingAction
        : null,
  };
};

const upsertOpsAgentStreamToolCall = (rows, nextToolCall) => {
  if (!nextToolCall?.id) {
    return rows;
  }

  const normalized = {
    ...nextToolCall,
    command: typeof nextToolCall.command === "string" ? nextToolCall.command : "",
    reason: typeof nextToolCall.reason === "string" ? nextToolCall.reason : "",
    label: typeof nextToolCall.label === "string" ? nextToolCall.label : "",
    status: typeof nextToolCall.status === "string" ? nextToolCall.status : "",
  };
  const index = rows.findIndex((item) => item.id === normalized.id);
  if (index === -1) {
    return [normalized, ...rows];
  }

  const next = [...rows];
  next[index] = {
    ...next[index],
    ...normalized,
  };
  return next;
};

export const reduceOpsAgentStreamEvent = (previousStream, event) => {
  const stream = previousStream || EMPTY_OPS_AGENT_STREAM;

  if (!event) {
    return { nextStream: stream };
  }

  if (event.stage === "error" && (!event.runId || !event.conversationId)) {
    return {
      nextStream: EMPTY_OPS_AGENT_STREAM,
      errorMessage: event.errorMessage,
    };
  }

  if (!event.runId || !event.conversationId) {
    return { nextStream: stream };
  }

  if (event.stage === "started") {
    return {
      nextStream: {
        runId: event.runId,
        conversationId: event.conversationId,
        text: "",
        toolCalls: [],
      },
      activateConversationId: event.conversationId,
    };
  }

  if (event.stage === "delta") {
    return {
      nextStream:
        stream.runId === event.runId
          ? { ...stream, text: `${stream.text}${event.chunk}` }
          : {
              runId: event.runId,
              conversationId: event.conversationId,
              text: event.chunk,
              toolCalls: [],
            },
    };
  }

  if (event.stage === "tool_call") {
    return {
      nextStream:
        stream.runId === event.runId
          ? {
              ...stream,
              toolCalls: upsertOpsAgentStreamToolCall(stream.toolCalls || [], event.toolCall),
            }
          : {
              runId: event.runId,
              conversationId: event.conversationId,
              text: "",
              toolCalls: event.toolCall ? [event.toolCall] : [],
            },
    };
  }

  if (event.stage === "tool_read") {
    return {
      nextStream:
        stream.runId === event.runId
          ? {
              ...stream,
              toolCalls: upsertOpsAgentStreamToolCall(stream.toolCalls || [], event.toolCall),
            }
          : stream,
      reloadConversationId: event.conversationId,
    };
  }

  if (event.stage === "requires_approval") {
    return {
      nextStream:
        stream.runId === event.runId
          ? {
              ...stream,
              toolCalls: upsertOpsAgentStreamToolCall(stream.toolCalls || [], event.toolCall),
            }
          : stream,
      pendingAction: event.pendingAction,
    };
  }

  if (event.stage === "completed") {
    return {
      nextStream: stream.runId === event.runId ? EMPTY_OPS_AGENT_STREAM : stream,
      pendingAction: event.pendingAction,
      reloadConversationId: event.conversationId,
      reloadConversations: true,
      reloadPendingActions: true,
    };
  }

  if (event.stage === "error") {
    return {
      nextStream: stream.runId === event.runId ? EMPTY_OPS_AGENT_STREAM : stream,
      errorMessage: event.errorMessage,
    };
  }

  return { nextStream: stream };
};
