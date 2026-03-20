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
      errorMessage: "boom",
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
      errorMessage: "",
      pendingAction: null,
    });

    expect(transition.nextStream).toEqual({
      runId: "run-1",
      conversationId: "conv-1",
      text: "",
    });
    expect(transition.activateConversationId).toBe("conv-1");
  });

  it("appends deltas to the active stream", () => {
    const transition = reduceOpsAgentStreamEvent(
      {
        runId: "run-1",
        conversationId: "conv-1",
        text: "hello",
      },
      {
        runId: "run-1",
        conversationId: "conv-1",
        stage: "delta",
        chunk: " world",
        errorMessage: "",
        pendingAction: null,
      },
    );

    expect(transition.nextStream.text).toBe("hello world");
  });

  it("marks completion and requests downstream refreshes", () => {
    const transition = reduceOpsAgentStreamEvent(
      {
        runId: "run-1",
        conversationId: "conv-1",
        text: "done",
      },
      {
        runId: "run-1",
        conversationId: "conv-1",
        stage: "completed",
        chunk: "",
        errorMessage: "",
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
      },
      {
        runId: "",
        conversationId: "",
        stage: "error",
        chunk: "",
        errorMessage: "network failed",
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
