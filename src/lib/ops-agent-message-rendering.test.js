import { describe, expect, it } from "vitest";

import {
  getOpsAgentAssistantReplyText,
  getOpsAgentLatestAssistantReplyText,
  getOpsAgentPreviewText,
  groupOpsAgentMessages,
  splitOpsAgentMessageContent,
} from "./ops-agent-message-rendering";

describe("splitOpsAgentMessageContent", () => {
  it("separates think blocks from visible reply content", () => {
    expect(
      splitOpsAgentMessageContent("<think>\ninternal\n</think>\n\n## Answer\n\nhello world"),
    ).toEqual([
      {
        type: "think",
        content: "internal",
      },
      {
        type: "content",
        content: "## Answer\n\nhello world",
      },
    ]);
  });

  it("treats an unfinished think block as thinking content", () => {
    expect(splitOpsAgentMessageContent("<think>\nstill thinking")).toEqual([
      {
        type: "think",
        content: "still thinking",
      },
    ]);
  });
});

describe("getOpsAgentAssistantReplyText", () => {
  it("returns the assistant-facing reply without think content", () => {
    expect(getOpsAgentAssistantReplyText("<think>internal</think>\n\nfinal answer")).toBe(
      "final answer",
    );
  });
});

describe("getOpsAgentPreviewText", () => {
  it("collapses whitespace and strips think tags from previews", () => {
    expect(getOpsAgentPreviewText("<think>internal note</think>\n\nhello\nworld")).toBe(
      "hello world",
    );
  });

  it("falls back to thought text when no visible reply exists", () => {
    expect(getOpsAgentPreviewText("<think>\nonly thought\n</think>")).toBe("only thought");
  });
});

describe("getOpsAgentLatestAssistantReplyText", () => {
  it("returns the latest visible assistant reply from a turn", () => {
    expect(
      getOpsAgentLatestAssistantReplyText([
        { role: "assistant", content: "status update" },
        { role: "tool", content: "tool output" },
        { role: "assistant", content: "<think>internal</think>\n\nfinal answer" },
      ]),
    ).toBe("final answer");
  });
});

describe("groupOpsAgentMessages", () => {
  it("keeps tool and assistant messages in the same agent turn until the next user message", () => {
    expect(
      groupOpsAgentMessages([
        { id: "u1", role: "user", content: "hello" },
        { id: "a1", role: "assistant", content: "checking" },
        { id: "t1", role: "tool", content: "tool output" },
        { id: "a2", role: "assistant", content: "done" },
        { id: "u2", role: "user", content: "thanks" },
      ]),
    ).toEqual([
      {
        id: "u1",
        kind: "user",
        message: { id: "u1", role: "user", content: "hello" },
      },
      {
        id: "turn-a1",
        kind: "agent_turn",
        messages: [
          { id: "a1", role: "assistant", content: "checking" },
          { id: "t1", role: "tool", content: "tool output" },
          { id: "a2", role: "assistant", content: "done" },
        ],
      },
      {
        id: "u2",
        kind: "user",
        message: { id: "u2", role: "user", content: "thanks" },
      },
    ]);
  });
});
