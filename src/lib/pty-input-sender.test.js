import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createPtyInputSender } from "./pty-input-sender";

describe("createPtyInputSender", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("batches rapid input for the same session while preserving order", async () => {
    const sent = [];
    const sender = createPtyInputSender({
      flushDelayMs: 10,
      send: async (sessionId, data) => {
        sent.push({ sessionId, data });
      },
    });

    sender.enqueue("session-1", "a");
    sender.enqueue("session-1", "b");
    sender.enqueue("session-1", "c");

    await vi.advanceTimersByTimeAsync(10);

    expect(sent).toEqual([{ sessionId: "session-1", data: "abc" }]);
  });

  it("splits long pending input into sequential chunks", async () => {
    const sent = [];
    const sender = createPtyInputSender({
      flushDelayMs: 5,
      maxChunkChars: 4,
      send: async (_sessionId, data) => {
        sent.push(data);
      },
    });

    sender.enqueue("session-1", "abcdefghij");
    await vi.runAllTimersAsync();

    expect(sent).toEqual(["abcd", "efgh", "ij"]);
  });

  it("isolates queues across different sessions", async () => {
    const sent = [];
    const sender = createPtyInputSender({
      flushDelayMs: 5,
      send: async (sessionId, data) => {
        sent.push({ sessionId, data });
      },
    });

    sender.enqueue("session-a", "hello");
    sender.enqueue("session-b", "world");
    await vi.runAllTimersAsync();

    expect(sent).toContainEqual({ sessionId: "session-a", data: "hello" });
    expect(sent).toContainEqual({ sessionId: "session-b", data: "world" });
    expect(sent).toHaveLength(2);
  });

  it("cancels pending input when the session is cleared or disposed", async () => {
    const send = vi.fn(async () => {});
    const sender = createPtyInputSender({
      flushDelayMs: 5,
      send,
    });

    sender.enqueue("session-1", "queued");
    sender.clearSession("session-1");
    sender.enqueue("session-2", "queued-too");
    sender.dispose();

    await vi.runAllTimersAsync();
    expect(send).not.toHaveBeenCalled();
  });

  it("reports send failures and drops the failed session queue", async () => {
    const send = vi.fn(async () => {
      throw new Error("boom");
    });
    const onError = vi.fn();
    const sender = createPtyInputSender({
      flushDelayMs: 5,
      maxChunkChars: 3,
      send,
      onError,
    });

    sender.enqueue("session-1", "abcdef");
    await vi.runAllTimersAsync();

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("session-1", "abc");
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
