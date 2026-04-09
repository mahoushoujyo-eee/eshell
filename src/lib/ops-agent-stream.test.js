import { describe, expect, it } from "vitest";

import {
  EMPTY_OPS_AGENT_STREAM,
  normalizeOpsAgentStreamEvent,
  reduceOpsAgentStreamEvent,
  upsertOpsAgentPendingAction,
} from "./ops-agent-stream";

describe("normalizeOpsAgentStreamEvent", () => {
  it("returns null for invalid payloads", () => {
    expect(normalizeOpsAgentStreamEvent(null)).toBeNull();
    expect(normalizeOpsAgentStreamEvent({})).toBeNull();
  });

  it("normalizes stream payload fields", () => {
    expect(
      normalizeOpsAgentStreamEvent({
        runId: "run-1",
        conversationId: "conv-1",
        stage: "delta",
        chunk: "hello",
        error: "boom",
      }),
    ).toEqual({
      runId: "run-1",
      conversationId: "conv-1",
      stage: "delta",
      chunk: "hello",
      createdAt: "",
      errorMessage: "boom",
      toolCall: null,
      pendingAction: null,
    });
  });
});

describe("reduceOpsAgentStreamEvent", () => {
  it("starts a new stream and activates the conversation", () => {
    const transition = reduceOpsAgentStreamEvent(EMPTY_OPS_AGENT_STREAM, {
      runId: "run-1",
      conversationId: "conv-1",
      stage: "started",
      chunk: "",
      createdAt: "",
      errorMessage: "",
      toolCall: null,
      pendingAction: null,
    });

    expect(transition.nextStream).toEqual({
      runId: "run-1",
      conversationId: "conv-1",
      text: "",
      toolCalls: [],
    });
    expect(transition.activateConversationId).toBe("conv-1");
  });

  it("appends deltas to the active stream", () => {
    const transition = reduceOpsAgentStreamEvent(
      {
        runId: "run-1",
        conversationId: "conv-1",
        text: "hello",
        toolCalls: [],
      },
      {
        runId: "run-1",
        conversationId: "conv-1",
        stage: "delta",
        chunk: " world",
        createdAt: "",
        errorMessage: "",
        toolCall: null,
        pendingAction: null,
      },
    );

    expect(transition.nextStream.text).toBe("hello world");
  });

  it("tracks tool call events while the agent is streaming", () => {
    const transition = reduceOpsAgentStreamEvent(
      {
        runId: "run-1",
        conversationId: "conv-1",
        text: "checking",
        toolCalls: [],
      },
      {
        runId: "run-1",
        conversationId: "conv-1",
        stage: "tool_call",
        chunk: "",
        createdAt: "",
        errorMessage: "",
        toolCall: {
          id: "tool-1",
          toolKind: "shell",
          command: "ls -la",
          reason: "inspect",
          status: "requested",
          label: "",
        },
        pendingAction: null,
      },
    );

    expect(transition.nextStream.toolCalls).toEqual([
      {
        id: "tool-1",
        toolKind: "shell",
        command: "ls -la",
        reason: "inspect",
        status: "requested",
        label: "",
      },
    ]);
  });

  it("marks completion and requests downstream refreshes", () => {
    const transition = reduceOpsAgentStreamEvent(
      {
        runId: "run-1",
        conversationId: "conv-1",
        text: "done",
        toolCalls: [{ id: "tool-1" }],
      },
      {
        runId: "run-1",
        conversationId: "conv-1",
        stage: "completed",
        chunk: "",
        createdAt: "",
        errorMessage: "",
        toolCall: null,
        pendingAction: { id: "action-1" },
      },
    );

    expect(transition.nextStream).toBe(EMPTY_OPS_AGENT_STREAM);
    expect(transition.pendingAction).toEqual({ id: "action-1" });
    expect(transition.reloadConversationId).toBe("conv-1");
    expect(transition.reloadConversations).toBe(true);
    expect(transition.reloadPendingActions).toBe(true);
  });

  it("clears the stream on transport-level errors without identifiers", () => {
    const transition = reduceOpsAgentStreamEvent(
      {
        runId: "run-1",
        conversationId: "conv-1",
        text: "partial",
        toolCalls: [],
      },
      {
        runId: "",
        conversationId: "",
        stage: "error",
        chunk: "",
        createdAt: "",
        errorMessage: "network failed",
        toolCall: null,
        pendingAction: null,
      },
    );

    expect(transition.nextStream).toBe(EMPTY_OPS_AGENT_STREAM);
    expect(transition.errorMessage).toBe("network failed");
  });
});

describe("upsertOpsAgentPendingAction", () => {
  it("inserts and updates pending actions by id", () => {
    const inserted = upsertOpsAgentPendingAction([], { id: "action-1", status: "pending" });
    expect(inserted).toEqual([{ id: "action-1", status: "pending" }]);

    const updated = upsertOpsAgentPendingAction(inserted, {
      id: "action-1",
      status: "executed",
    });
    expect(updated).toEqual([{ id: "action-1", status: "executed" }]);
  });
});
