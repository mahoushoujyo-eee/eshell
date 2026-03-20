export const EMPTY_OPS_AGENT_STREAM = Object.freeze({
  runId: null,
  conversationId: null,
  text: "",
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
    errorMessage: typeof payload.error === "string" ? payload.error : "",
    pendingAction:
      payload.pendingAction && typeof payload.pendingAction === "object"
        ? payload.pendingAction
        : null,
  };
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
            },
    };
  }

  if (event.stage === "tool_read") {
    return {
      nextStream: stream,
      reloadConversationId: event.conversationId,
    };
  }

  if (event.stage === "requires_approval") {
    return {
      nextStream: stream,
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
