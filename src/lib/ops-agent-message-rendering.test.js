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

  it("hides leaked planner tool-call markup from assistant content", () => {
    expect(
      splitOpsAgentMessageContent(
        "<minimax:tool_call>\n<invoke name=\"shell\">\n<command\">ls -la</command>\n</invoke>\n</minimax:tool_call>",
      ),
    ).toEqual([]);
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
        sourceUserMessageId: "u1",
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

  it("merges streaming content into the current agent turn", () => {
    expect(
      groupOpsAgentMessages(
        [
          { id: "u1", role: "user", content: "hello" },
          { id: "t1", role: "tool", content: "tool output" },
        ],
        { isStreaming: true, streamingText: "working on it" },
      ),
    ).toEqual([
      {
        id: "u1",
        kind: "user",
        message: { id: "u1", role: "user", content: "hello" },
      },
      {
        id: "turn-t1",
        kind: "agent_turn",
        sourceUserMessageId: "u1",
        messages: [{ id: "t1", role: "tool", content: "tool output" }],
        isStreaming: true,
        streamingText: "working on it",
        streamingToolCalls: [],
        streamingAgentProgress: null,
      },
    ]);
  });

  it("creates a pending agent turn when streaming starts before any agent message", () => {
    expect(
      groupOpsAgentMessages([{ id: "u1", role: "user", content: "hello" }], {
        isStreaming: true,
        streamingText: "",
      }),
    ).toEqual([
      {
        id: "u1",
        kind: "user",
        message: { id: "u1", role: "user", content: "hello" },
      },
      {
        id: "__streaming__",
        kind: "agent_turn",
        sourceUserMessageId: "u1",
        messages: [],
        isStreaming: true,
        streamingText: "",
        streamingToolCalls: [],
        streamingAgentProgress: null,
      },
    ]);
  });

  it("injects pending approval actions into the related agent turn", () => {
    expect(
      groupOpsAgentMessages(
        [
          { id: "u1", role: "user", content: "check mysql", createdAt: "2026-04-08T23:59:58Z" },
          { id: "a1", role: "assistant", content: "I need approval.", createdAt: "2026-04-09T00:00:01Z" },
        ],
        {
          conversationId: "conv-1",
          pendingActions: [
            {
              id: "action-1",
              conversationId: "conv-1",
              sourceUserMessageId: "u1",
              toolKind: "shell",
              command: "ssh node mysql --version",
              reason: "inspect mysql",
              createdAt: "2026-04-09T00:00:00Z",
            },
          ],
        },
      ),
    ).toEqual([
      {
        id: "u1",
        kind: "user",
        message: {
          id: "u1",
          role: "user",
          content: "check mysql",
          createdAt: "2026-04-08T23:59:58Z",
        },
      },
      {
        id: "turn-a1",
        kind: "agent_turn",
        sourceUserMessageId: "u1",
        messages: [
          {
            id: "pending-action:action-1",
            role: "tool",
            content: "ssh node mysql --version",
            createdAt: "2026-04-09T00:00:00Z",
            toolKind: "shell",
            toolState: "awaiting_approval",
            pendingAction: {
              id: "action-1",
              conversationId: "conv-1",
              sourceUserMessageId: "u1",
              toolKind: "shell",
              command: "ssh node mysql --version",
              reason: "inspect mysql",
              createdAt: "2026-04-09T00:00:00Z",
            },
          },
          {
            id: "a1",
            role: "assistant",
            content: "I need approval.",
            createdAt: "2026-04-09T00:00:01Z",
          },
        ],
      },
    ]);
  });

  it("does not inject resolved approval actions into the agent turn", () => {
    expect(
      groupOpsAgentMessages(
        [
          { id: "u1", role: "user", content: "check mysql", createdAt: "2026-04-08T23:59:58Z" },
          {
            id: "t1",
            role: "tool",
            toolKind: "shell",
            content: "shell action executed.\nCommand: mysql --version\nExit: 0\nmysql 8.0",
            createdAt: "2026-04-09T00:00:02Z",
          },
        ],
        {
          conversationId: "conv-1",
          pendingActions: [
            {
              id: "action-1",
              conversationId: "conv-1",
              sourceUserMessageId: "u1",
              toolKind: "shell",
              command: "mysql --version",
              status: "executed",
              createdAt: "2026-04-09T00:00:00Z",
              executionOutput: "mysql 8.0",
            },
          ],
        },
      ),
    ).toEqual([
      {
        id: "u1",
        kind: "user",
        message: {
          id: "u1",
          role: "user",
          content: "check mysql",
          createdAt: "2026-04-08T23:59:58Z",
        },
      },
      {
        id: "turn-t1",
        kind: "agent_turn",
        sourceUserMessageId: "u1",
        messages: [
          {
            id: "t1",
            role: "tool",
            toolKind: "shell",
            content: "shell action executed.\nCommand: mysql --version\nExit: 0\nmysql 8.0",
            createdAt: "2026-04-09T00:00:02Z",
          },
        ],
      },
    ]);
  });

  it("surfaces streaming tool calls inside the current turn", () => {
    expect(
      groupOpsAgentMessages(
        [{ id: "u1", role: "user", content: "inspect flink" }],
        {
          isStreaming: true,
          streamingText: "checking",
          streamingToolCalls: [
            {
              id: "tool-1",
              toolKind: "shell",
              command: "ls -la /opt/module/flink/conf",
              status: "requested",
            },
          ],
        },
      ),
    ).toEqual([
      {
        id: "u1",
        kind: "user",
        message: { id: "u1", role: "user", content: "inspect flink" },
      },
      {
        id: "__streaming__",
        kind: "agent_turn",
        sourceUserMessageId: "u1",
        messages: [],
        isStreaming: true,
        streamingText: "checking",
        streamingToolCalls: [
          {
            id: "tool-1",
            role: "tool",
            content: "ls -la /opt/module/flink/conf",
            createdAt: "",
            toolKind: "shell",
            toolState: "requested",
            toolCall: {
              id: "tool-1",
              toolKind: "shell",
              command: "ls -la /opt/module/flink/conf",
              status: "requested",
            },
          },
        ],
        streamingAgentProgress: null,
      },
    ]);
  });
});
