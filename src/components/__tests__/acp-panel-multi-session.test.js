/**
 * The ACP panel shell over the multi-conversation state.
 *
 * The panel is a pure view, so these are structural assertions on the fake DOM:
 * one tab per conversation, the active one marked, the transcript of the active
 * conversation rendered, and the tab strip's actions wired to the right
 * callbacks. The behaviour behind them (never stopping a sibling conversation)
 * is covered by `src/hooks/useAcpAgent.test.js`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";

// The dialog is the OS file picker: the panel only needs the paths back.
const dialogState = vi.hoisted(() => ({ open: vi.fn(async () => []) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: dialogState.open }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

import { createElement } from "react";
import {
  FakeEvent,
  findElement,
  findElements,
  installFakeDom,
  uninstallFakeDom,
} from "../../test/fake-dom.js";
import { fireClick, render } from "../../test/react-render.js";
import { I18nProvider } from "../../lib/i18n.js";
import AcpAgentPanel from "../panels/AcpAgentPanel.jsx";

const AGENT_A = {
  id: "a",
  name: "Agent A",
  command: "npx",
  args: ["codex-acp"],
  running: true,
  cwd: "D:\\proj",
};
const AGENT_B = {
  id: "b",
  name: "Agent B",
  command: "npx",
  args: ["claude-acp"],
  running: false,
  cwd: "D:\\proj",
};

const EMPTY_DRAFT = { text: "", attachments: [], shellContext: null };

const conversation = (overrides = {}) => ({
  key: "c1",
  agentId: "a",
  agentName: "Agent A",
  sessionId: "sess-1",
  phase: "ready",
  cwd: "D:\\proj",
  projectId: null,
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
  resumeRequested: false,
  draft: { ...EMPTY_DRAFT },
  title: "",
  createdAt: "2026-11-06T00:00:00.000Z",
  ...overrides,
});

const makeAcp = (overrides = {}) => ({
  conversations: [],
  activeKey: null,
  setActiveKey: vi.fn(),
  activeConversation: null,
  agents: [AGENT_A, AGENT_B],
  openSession: vi.fn(async () => "c1"),
  closeSession: vi.fn(async () => {}),
  stopAgent: vi.fn(async () => {}),
  phase: "idle",
  session: null,
  authMethods: [],
  transcript: [],
  plan: null,
  commands: [],
  configOptions: [],
  usage: null,
  turnActive: false,
  draft: { ...EMPTY_DRAFT },
  standaloneNotices: [],
  history: [],
  projects: [],
  addProject: vi.fn(),
  deleteProject: vi.fn(),
  startSession: vi.fn(),
  resumeHistory: vi.fn(),
  deleteHistoryRecord: vi.fn(async () => {}),
  sendPrompt: vi.fn(async () => true),
  cancelTurn: vi.fn(),
  setMode: vi.fn(),
  setConfigOption: vi.fn(),
  respondPermission: vi.fn(),
  clearShellContext: vi.fn(),
  setDraft: vi.fn(),
  authenticate: vi.fn(),
  runtimeEnv: null,
  envMissing: false,
  refreshRuntimeEnv: vi.fn(),
  ...overrides,
});

const mountPanel = (acp) =>
  render(createElement(I18nProvider, null, createElement(AcpAgentPanel, { acp })));

const buttons = (container, label) =>
  findElements(
    container,
    (node) => node.nodeName === "BUTTON" && node.getAttribute("aria-label") === label,
  );

beforeEach(() => installFakeDom());
afterEach(() => uninstallFakeDom());

describe("AcpAgentPanel with no conversation", () => {
  it("offers every configured agent and starts the one clicked", async () => {
    const acp = makeAcp();
    const { container, unmount } = await mountPanel(acp);

    expect(container.textContent).toContain("Agent A");
    expect(container.textContent).toContain("Agent B");

    const starter = findElement(
      container,
      (node) => node.nodeName === "BUTTON" && node.textContent.includes("Agent B"),
    );
    await act(async () => {
      fireClick(starter);
    });
    expect(acp.openSession).toHaveBeenCalledWith({ agentId: "b", project: null });
    await unmount();
  });

  it("starts a conversation in the path chosen next to the title", async () => {
    const acp = makeAcp({
      projects: [{ id: "p1", name: "demo", path: "D:\\demo" }],
    });
    const { container, unmount } = await mountPanel(acp);

    // Open the path picker, which defaults to "the agent's own directory".
    const trigger = findElement(
      container,
      (node) => node.nodeName === "BUTTON" && node.textContent.includes("Default path"),
    );
    await act(async () => {
      fireClick(trigger);
    });

    const option = findElement(
      container,
      (node) => node.nodeName === "BUTTON" && node.textContent.includes("demo"),
    );
    await act(async () => {
      fireClick(option);
    });

    const starter = findElement(
      container,
      (node) => node.nodeName === "BUTTON" && node.textContent.includes("Agent B"),
    );
    await act(async () => {
      fireClick(starter);
    });

    expect(acp.openSession).toHaveBeenCalledWith({
      agentId: "b",
      project: { id: "p1", name: "demo", path: "D:\\demo" },
    });
    await unmount();
  });

  it("points at the conversation surface instead of a start button", async () => {
    const acp = makeAcp({ agents: [] });
    const { container, unmount } = await mountPanel(acp);

    expect(container.textContent).toContain("No agent configured");
    await unmount();
  });
});

describe("AcpAgentPanel with live conversations", () => {
  const twoConversations = () => [
    conversation({
      key: "c1",
      sessionId: "sess-1",
      transcript: [{ id: "e1", type: "assistant", text: "hello from first" }],
    }),
    conversation({
      key: "c2",
      agentId: "b",
      agentName: "Agent B",
      sessionId: "sess-2",
      transcript: [{ id: "e2", type: "assistant", text: "hello from second" }],
    }),
  ];

  it("renders one tab per conversation and marks the active one", async () => {
    const conversations = twoConversations();
    const acp = makeAcp({
      conversations,
      activeKey: "c1",
      activeConversation: conversations[0],
      phase: "ready",
      session: { id: "sess-1", modes: null, capabilities: null },
    });
    const { container, unmount } = await mountPanel(acp);

    const tabs = findElements(container, (node) => node.getAttribute("role") === "tab");
    expect(tabs).toHaveLength(2);
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    expect(tabs[1].getAttribute("aria-selected")).toBe("false");
    await unmount();
  });

  it("shows the transcript of the active conversation only", async () => {
    const conversations = twoConversations();
    const acp = makeAcp({
      conversations,
      activeKey: "c1",
      activeConversation: conversations[0],
      phase: "ready",
      session: { id: "sess-1", modes: null, capabilities: null },
      transcript: conversations[0].transcript,
    });
    const { container, unmount } = await mountPanel(acp);

    expect(container.textContent).toContain("hello from first");
    expect(container.textContent).not.toContain("hello from second");
    await unmount();
  });

  it("switches conversation when another tab is clicked", async () => {
    const conversations = twoConversations();
    const acp = makeAcp({
      conversations,
      activeKey: "c1",
      activeConversation: conversations[0],
      phase: "ready",
      session: { id: "sess-1", modes: null, capabilities: null },
    });
    const { container, unmount } = await mountPanel(acp);

    const tabs = findElements(container, (node) => node.getAttribute("role") === "tab");
    await act(async () => {
      fireClick(tabs[1]);
    });
    expect(acp.setActiveKey).toHaveBeenCalledWith("c2");
    // Switching is not a stop: nothing was closed or killed.
    expect(acp.closeSession).not.toHaveBeenCalled();
    expect(acp.stopAgent).not.toHaveBeenCalled();
    await unmount();
  });

  it("closes a conversation from its tab", async () => {
    const conversations = twoConversations();
    const acp = makeAcp({
      conversations,
      activeKey: "c1",
      activeConversation: conversations[0],
      phase: "ready",
      session: { id: "sess-1", modes: null, capabilities: null },
    });
    const { container, unmount } = await mountPanel(acp);

    const close = findElement(
      container,
      (node) =>
        node.nodeName === "BUTTON" &&
        String(node.getAttribute("aria-label") || "").startsWith("Close conversation"),
    );
    await act(async () => {
      fireClick(close);
    });
    expect(acp.closeSession).toHaveBeenCalledWith("c1");
    await unmount();
  });

  it("opens a new conversation from the plus menu without touching the current one", async () => {
    const conversations = twoConversations();
    const acp = makeAcp({
      conversations,
      activeKey: "c1",
      activeConversation: conversations[0],
      phase: "ready",
      session: { id: "sess-1", modes: null, capabilities: null },
    });
    const { container, unmount } = await mountPanel(acp);

    const plus = buttons(container, "New conversation")[0];
    await act(async () => {
      fireClick(plus);
    });
    // Scope the lookup to the popover: the second tab also contains "Agent B".
    const menu = findElement(
      container,
      (node) =>
        typeof node.className === "string" &&
        node.className.includes("absolute") &&
        node.className.includes("shadow-overlay"),
    );
    const pick = findElement(
      menu,
      (node) => node.nodeName === "BUTTON" && node.textContent.includes("Agent B"),
    );
    await act(async () => {
      fireClick(pick);
    });

    expect(acp.openSession).toHaveBeenCalledWith({ agentId: "b" });
    expect(acp.stopAgent).not.toHaveBeenCalled();
    await unmount();
  });

  it("badges a conversation waiting for approval", async () => {
    const conversations = [
      conversation({
        key: "c1",
        transcript: [
          {
            id: "p1",
            type: "permission",
            requestId: "req-1",
            toolCall: null,
            options: [],
            resolution: null,
            resolving: false,
          },
        ],
      }),
      conversation({ key: "c2", agentId: "b", agentName: "Agent B", sessionId: "sess-2" }),
    ];
    const acp = makeAcp({
      conversations,
      activeKey: "c2",
      activeConversation: conversations[1],
      phase: "ready",
      session: { id: "sess-2", modes: null, capabilities: null },
    });
    const { container, unmount } = await mountPanel(acp);

    const tab = findElement(container, (node) => node.getAttribute("role") === "tab");
    expect(tab.textContent).toContain("1");
    await unmount();
  });

  it("lets a project choose which agent starts the new conversation", async () => {
    const conversations = twoConversations();
    const acp = makeAcp({
      conversations,
      activeKey: "c1",
      activeConversation: conversations[0],
      phase: "ready",
      session: { id: "sess-1", modes: null, capabilities: null },
      projects: [{ id: "p1", name: "demo", path: "D:\\demo" }],
    });
    const { container, unmount } = await mountPanel(acp);

    await act(async () => {
      fireClick(buttons(container, "Conversations")[0]);
    });

    // The project rows' "+" opens an agent list; the default "No project" group
    // renders first, so the last one belongs to the real project.
    const addButtons = findElements(
      container,
      (node) =>
        node.nodeName === "BUTTON" &&
        node.getAttribute("title") === "New conversation in this project",
    );
    expect(addButtons.length).toBe(2);
    await act(async () => {
      fireClick(addButtons[addButtons.length - 1]);
    });

    // Rows in the chooser carry the agent's spawn command as their tooltip.
    const pick = findElement(
      container,
      (node) => node.nodeName === "BUTTON" && node.getAttribute("title") === "npx claude-acp",
    );
    await act(async () => {
      fireClick(pick);
    });

    expect(acp.startSession).toHaveBeenCalledWith({
      project: { id: "p1", name: "demo", path: "D:\\demo" },
      agentId: "b",
    });
    await unmount();
  });

  it("toggles the history panel over the live conversation", async () => {    const conversations = twoConversations();
    const acp = makeAcp({
      conversations,
      activeKey: "c1",
      activeConversation: conversations[0],
      phase: "ready",
      session: { id: "sess-1", modes: null, capabilities: null },
      history: [
        {
          id: "old-1",
          agentId: "a",
          agentName: "Agent A",
          title: "earlier work",
          createdAt: "",
          updatedAt: new Date().toISOString(),
          projectId: null,
          cwd: "D:\\proj",
        },
      ],
      transcript: conversations[0].transcript,
    });
    const { container, unmount } = await mountPanel(acp);

    const historyButton = buttons(container, "Conversations")[0];
    await act(async () => {
      fireClick(historyButton);
    });

    expect(container.textContent).toContain("earlier work");
    // The conversation is still mounted underneath, not replaced by the panel.
    expect(container.textContent).toContain("hello from first");
    await unmount();
  });

  it("keeps an ended conversation readable and offers a restart", async () => {
    const ended = conversation({
      phase: "ended",
      ended: true,
      transcript: [{ id: "e1", type: "assistant", text: "work that already ran" }],
    });
    const acp = makeAcp({
      conversations: [ended],
      activeKey: "c1",
      activeConversation: ended,
      phase: "ended",
      session: { id: "sess-1", modes: null, capabilities: null },
      transcript: ended.transcript,
    });
    const { container, unmount } = await mountPanel(acp);

    expect(container.textContent).toContain("Session ended");
    expect(container.textContent).toContain("work that already ran");

    const restart = findElement(
      container,
      (node) => node.nodeName === "BUTTON" && node.textContent.trim() === "Start again",
    );
    await act(async () => {
      fireClick(restart);
    });
    // Restart drops the dead tab and opens a fresh conversation with the same agent.
    expect(acp.closeSession).toHaveBeenCalledWith("c1");
    expect(acp.openSession).toHaveBeenCalledWith({
      agentId: "a",
      project: { id: null, path: "D:\\proj" },
    });
    await unmount();
  });

  it("shows the sign-in card when the agent needs authentication", async () => {
    const auth = conversation({
      phase: "auth",
      sessionId: null,
      authMethods: [{ id: "oauth", name: "Sign in with a browser" }],
    });
    const acp = makeAcp({
      conversations: [auth],
      activeKey: "c1",
      activeConversation: auth,
      phase: "auth",
      session: { id: null, modes: null, capabilities: null },
      authMethods: auth.authMethods,
    });
    const { container, unmount } = await mountPanel(acp);

    expect(container.textContent).toContain("Sign-in required");
    const method = findElement(
      container,
      (node) => node.nodeName === "BUTTON" && node.textContent.includes("Sign in with a browser"),
    );
    await act(async () => {
      fireClick(method);
    });
    expect(acp.authenticate).toHaveBeenCalledWith("oauth");
    await unmount();
  });
});

/** A ready conversation with a transcript, for the composer affordances. */
const readyConversation = (overrides = {}) => {
  const row = conversation({ transcript: [{ id: "t1", type: "assistant", text: "Plan: restart nginx" }] });
  return { row: { ...row, ...overrides } };
};

const readyAcp = (setDraft) => {
  const { row } = readyConversation();
  return makeAcp({
    conversations: [row],
    activeKey: "c1",
    activeConversation: row,
    phase: "ready",
    session: { id: "sess-1", modes: null, capabilities: null },
    // The panel renders the hook's derived transcript, not the row's copy.
    transcript: row.transcript,
    draft: { text: "", attachments: [], shellContext: null },
    setDraft,
  });
};

describe("AcpAgentPanel composer context", () => {
  it("adds the chosen file paths to the prompt instead of their contents", async () => {
    dialogState.open.mockResolvedValue(["C:\\work\\a.ts", "C:\\work\\b.md"]);
    const setDraft = vi.fn();
    const { container, unmount } = await mountPanel(readyAcp(setDraft));

    const attach = findElement(
      container,
      (node) => node.nodeName === "BUTTON" && node.getAttribute("aria-label") === "Attach file paths",
    );
    await act(async () => {
      fireClick(attach);
    });
    await act(async () => {});

    // Paths, not contents: the agent reads the file itself.
    expect(setDraft).toHaveBeenCalledWith({ text: "`C:\\work\\a.ts`\n`C:\\work\\b.md`" });
    await unmount();
  });

  it("quotes the selected transcript text into the prompt", async () => {
    const setDraft = vi.fn();
    const { container, unmount } = await mountPanel(readyAcp(setDraft));

    // The deepest node holding the reply: an ancestor would not be "inside" the
    // scroller, and the panel only quotes selections from the transcript.
    const matches = findElements(
      container,
      (node) => (node.textContent || "").includes("Plan: restart nginx"),
    );
    const selected = matches[matches.length - 1];
    const panel = findElement(
      container,
      (node) => (node.getAttribute("class") || "").includes("bg-surface"),
    );
    const scroller = findElement(
      container,
      (node) => (node.getAttribute("class") || "").includes("scroll-region"),
    );
    panel.getBoundingClientRect = () => ({ left: 0, top: 0, right: 400, bottom: 600 });
    window.getSelection = () => ({
      toString: () => "Plan: restart nginx\nand reload",
      anchorNode: selected,
      rangeCount: 1,
      getRangeAt: () => ({
        getBoundingClientRect: () => ({ left: 10, top: 10, right: 50, bottom: 20, width: 40, height: 10 }),
      }),
      removeAllRanges: () => {},
    });

    await act(async () => {
      scroller.dispatchEvent(new FakeEvent("mouseup", { target: selected }));
    });

    const quote = findElement(
      container,
      (node) => node.nodeName === "BUTTON" && (node.textContent || "").includes("Quote in reply"),
    );
    expect(quote).toBeTruthy();

    await act(async () => {
      fireClick(quote);
    });

    expect(setDraft).toHaveBeenCalledWith({ text: "> Plan: restart nginx\n> and reload" });
    await unmount();
  });
});
