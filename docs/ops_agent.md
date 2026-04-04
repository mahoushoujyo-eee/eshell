# Ops Agent Guide

This document describes the current Ops Agent behavior in eShell.

## 1. UX Behavior

From the Ops Agent panel, the user can:
- create, switch, and delete conversations
- bind a conversation to the active shell session
- stream assistant replies in real time
- attach selected shell output as user-provided context
- manually compact the active conversation from the header action
- review and resolve approval-gated actions

The panel exposes conversation compaction as a manual action, while the backend can also compact automatically before a chat run continues.

## 2. Backend Surface

Tauri commands:
- `ops_agent_list_conversations`
- `ops_agent_create_conversation`
- `ops_agent_get_conversation`
- `ops_agent_delete_conversation`
- `ops_agent_set_active_conversation`
- `ops_agent_compact_conversation`
- `ops_agent_chat_stream_start`
- `ops_agent_list_pending_actions`
- `ops_agent_resolve_action`
- `ops_agent_cancel_run`

Event channel:
- `ops-agent-stream`

Frontend integration points:
- `src/lib/tauri-api.js`
- `src/lib/ops-agent-stream.js`
- `src/hooks/workbench/operations.js`

## 3. Chat Run Lifecycle

1. `ops_agent_chat_stream_start` validates the request, ensures or creates the target conversation, appends the user message, and registers one active run for that conversation.
2. The backend emits `started` on `ops-agent-stream`.
3. Before the planner loop runs, the backend estimates prompt size. If the conversation is already above `AiConfig.maxContextTokens`, it attempts automatic history compaction.
4. The ReAct loop runs with a hard limit of `8` tool-planning steps.
5. Each step either:
   - returns a final assistant reply without tool use
   - executes a registered tool and appends a `Tool` message
   - creates a pending action that must be approved in the UI
6. On successful completion, the backend appends the final assistant message and emits `completed`.
7. On failure, the backend emits `error`.
8. On user cancellation, the run registry is marked cancelled and the backend emits `completed` with an empty answer so the frontend can clear the active streaming state.

Important code paths:
- `src-tauri/src/ops_agent/service/chat.rs`
- `src-tauri/src/ops_agent/service/react_loop.rs`
- `src-tauri/src/ops_agent/service/runtime.rs`
- `src-tauri/src/ops_agent/run_registry.rs`

## 4. Stream Event Semantics

Event name:
- `ops-agent-stream`

Payload fields (camelCase):
- `runId`
- `conversationId`
- `stage`
- `chunk`
- `fullAnswer`
- `pendingAction`
- `error`
- `createdAt`

Stage values:
- `started`
- `delta`
- `tool_read`
- `requires_approval`
- `completed`
- `error`

Stage behavior:
- `started`: marks the active run and resets frontend stream text.
- `delta`: appends streamed answer chunks.
- `tool_read`: tells the frontend to reload the conversation because the backend appended a tool message.
- `requires_approval`: carries a pending action payload for approval UI.
- `completed`: ends the run and may carry `fullAnswer` plus the last pending action snapshot.
- `error`: ends the run with an error message.

There is no dedicated `cancelled` stream stage today. Cancellation is surfaced as a completed run with empty answer text.

## 5. Tooling and Approval Model

The default tool registry currently exposes:
- `shell`
- `ui_context`

Compatibility aliases `read_shell` and `write_shell` map to the unified `shell` tool.

Behavior summary:
- safe or read-only shell actions can execute immediately
- risky shell actions are converted into pending actions instead of failing outright
- pending actions are stored with `pending`, `executed`, `failed`, or `rejected` status

When the user resolves an action through `ops_agent_resolve_action`:
- rejected actions add an assistant notice and stop there
- executed or failed actions append a tool message
- if the original user turn can be reconstructed, the backend resumes the interrupted ReAct flow automatically from that conversation turn

Important code paths:
- `src-tauri/src/ops_agent/tools/mod.rs`
- `src-tauri/src/ops_agent/tools/shell.rs`
- `src-tauri/src/ops_agent/service/resolve.rs`
- `src-tauri/src/ops_agent/store.rs`

## 6. Conversation Compaction

Compaction exists to keep a long-running conversation inside the configured context window.

Manual compaction:
- frontend invokes `ops_agent_compact_conversation`
- backend rewrites the conversation history immediately

Automatic compaction:
- triggered at chat-run start when the estimated prompt size is above `AiConfig.maxContextTokens`
- runs before the planner loop continues

Compaction strategy:
- keep a token-based tail of recent messages
- always keep at least the most recent `2` messages
- summarize the older prefix using the configured model
- if summary generation fails, fall back to a local heuristic summary
- replace the old prefix with:
  - one `System` boundary message
  - one `Assistant` summary message
  - the preserved recent tail

Result fields returned by the RPC:
- `conversation`
- `compacted`
- `note`
- `estimatedTokensBefore`
- `estimatedTokensAfter`

Important code paths:
- `src-tauri/src/ops_agent/compact.rs`
- `src-tauri/src/ops_agent/service/compact.rs`

## 7. Persistence and Logs

Persistent files under `.eshell-data/`:
- `ops_agent_conversation_list.json`
- `ops_agent_conversations/<conversation-id>.json`
- `ops_agent_debug.log`

Persistence rules:
- conversation summaries, active conversation id, and pending actions are stored in the list file
- full message history for each conversation is stored as a separate JSON document
- pending actions are not stored inside individual conversation files

Runtime-only state:
- run registry and cancellation flags
- current streaming run ownership per conversation

Important code paths:
- `src-tauri/src/ops_agent/store.rs`
- `src-tauri/src/ops_agent/logging.rs`
- `src-tauri/src/ops_agent/run_registry.rs`

## 8. Current Limitations

- Chat runs are not resumable after app restart.
- Stream cancellation does not have its own stage; consumers must treat empty `completed` events as a cancelled-or-empty terminal state.
- Compaction is destructive by design: older raw messages are replaced by a summary.
- Summary quality depends on the configured model and fallback heuristics.
