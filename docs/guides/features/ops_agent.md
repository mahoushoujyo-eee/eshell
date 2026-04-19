# Ops Agent Guide

This document describes the current Ops Agent behavior in eShell, including the latest image-based multimodal chat flow.

Architecture reference:

- layered package map: [docs/guides/architecture/ops_agent_layered_architecture.md](/E:/cctest/eshell-codex/eshell-codex/docs/guides/architecture/ops_agent_layered_architecture.md)

## 1. UX Behavior

From the Ops Agent panel, the user can:

- create, switch, and delete conversations
- bind a conversation to the active shell session
- stream assistant replies in real time
- switch the active AI profile from the chat footer
- choose provider protocol type when editing an AI profile
- attach selected shell output as user-provided context
- upload one or more images together with a user message
- click image tags in already-sent user messages to view stored image content
- manually compact the active conversation from the header action
- review and resolve approval-gated actions
- view localized UI copy in English or Simplified Chinese

The panel exposes conversation compaction as a manual action, while the backend can also compact automatically before a chat run continues.

## 2. Backend Surface

Tauri commands:

- `ops_agent_list_conversations`
- `ops_agent_create_conversation`
- `ops_agent_get_conversation`
- `ops_agent_get_attachment_content`
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

Profile and config persistence:

- `src-tauri/.eshell-data/ai_profiles.json`

Important code paths:

- `src-tauri/src/storage/ai_profiles.rs`
- `src-tauri/src/models.rs`
- `src/hooks/workbench/aiProfiles.js`
- `src/components/sidebar/AiConfigModal.jsx`
- `src/components/panels/ai-assistant/AiComposer.jsx`

## 3. Provider and Profile Configuration

AI configuration is now split into two concerns:

- a global active profile id
- one or more saved AI profiles

Each profile now carries an `apiType` in addition to `baseUrl`, `apiKey`, and `model`.

Supported `apiType` values:

- `openai_chat_completions`
- `openai_responses`
- `anthropic_messages`

Default base URLs:

- `openai_chat_completions` -> `https://api.openai.com/v1`
- `openai_responses` -> `https://api.openai.com/v1`
- `anthropic_messages` -> `https://api.anthropic.com`

Current behavior:

- the active profile is global, not conversation-scoped
- switching profiles updates the next request, not the already-running request
- an in-flight chat run reads `AiConfig` once at run start and keeps that snapshot for the whole run
- approval mode remains global and is stored beside the profile list, not inside each profile

UI behavior:

- the profile editor lets the user choose provider type explicitly
- provider iconography is shown in the profile editor, profile bar, and model selector
- chat footer no longer renders a duplicate provider badge next to the model selector

## 4. Message and Attachment Model

The current message model distinguishes between:

- text content stored directly on the message
- optional shell context attached to user messages
- image attachment ids stored on the message as `attachmentIds`

Important rules:

- incoming chat requests may contain `imageAttachments`, each with `fileName`, `contentType`, and `contentBase64`
- conversation JSON does not store raw image bytes
- stored message records only keep `attachmentIds`
- raw image bytes and metadata are stored separately under `.eshell-data/ops_agent_attachments/`
- the frontend fetches image content on demand through `ops_agent_get_attachment_content`

This keeps conversation files small and avoids duplicating large base64 payloads inside message history.

## 5. Chat Run Lifecycle

1. `ops_agent_chat_stream_start` validates the request.
2. The backend accepts:
   - text-only messages
   - text + shell context
   - text + images
   - image-only messages where `question` is an empty string
3. If `imageAttachments` are present, the backend saves them into the attachment store before the run starts.
4. The backend ensures or creates the target conversation, appends the user message, and stores only attachment ids on that message.
5. The backend registers one active run for that conversation.
6. The backend emits `started` on `ops-agent-stream`.
7. Before the planner loop runs, the backend estimates prompt size. If the conversation is already above `AiConfig.maxContextTokens`, it attempts automatic history compaction.
8. The ReAct loop runs with a hard limit of `8` tool-planning steps.
9. Each step either:
   - returns a final assistant reply without tool use
   - executes a registered tool and appends a `Tool` message
   - creates a pending action that must be approved in the UI
10. When user history is serialized for the provider, the backend resolves `attachmentIds` back into local image content and emits a multimodal provider message.
11. On successful completion, the backend appends the final assistant message and emits `completed`.
12. On failure, the backend emits `error`.
13. On user cancellation, the run registry is marked cancelled and the backend emits `completed` with an empty answer so the frontend can clear the active streaming state.
14. If the user changes the active profile while a run is already streaming, that change does not alter the current run; it applies to the next chat request.

Important code paths:

- `src-tauri/src/ops_agent/application/chat.rs`
- `src-tauri/src/ops_agent/core/llm.rs`
- `src-tauri/src/ops_agent/core/react_loop.rs`
- `src-tauri/src/ops_agent/core/runtime.rs`
- `src-tauri/src/ops_agent/infrastructure/attachments.rs`
- `src-tauri/src/ops_agent/infrastructure/run_registry.rs`

## 6. Provider Protocol Flow

The provider layer no longer assumes that every chat message is plain text or that every vendor speaks the same protocol.

Current behavior:

- `providers/mod.rs` selects a transport implementation from `AiConfig.apiType`
- all providers receive the same internal `ProviderChatMessage` structure
- user messages without images are serialized as text
- user messages with images are serialized as multimodal message parts
- text, shell context summary, and attachment summary remain in the text part
- each referenced image becomes an `image_url` part with a local `data:` URL payload

Supported transports:

- `openai_compat.rs`: OpenAI Chat Completions compatible `messages` protocol
- `openai_responses.rs`: OpenAI Responses `input` protocol
- `anthropic.rs`: Anthropic Messages `messages` protocol

Important protocol details:

- OpenAI Chat Completions keeps assistant and user history in a classic `messages` array
- OpenAI Responses uses role-aware content-part types
- assistant history text for OpenAI Responses must be serialized as `output_text`
- user history text for OpenAI Responses must be serialized as `input_text`
- Anthropic transport maps image parts and tool calls to the Messages API shape

This means images are not only stored locally for UI preview. They also participate in model input during planning and answer generation.

Important code paths:

- `src-tauri/src/ops_agent/providers/types.rs`
- `src-tauri/src/ops_agent/providers/openai_compat.rs`
- `src-tauri/src/ops_agent/providers/openai_responses.rs`
- `src-tauri/src/ops_agent/providers/anthropic.rs`
- `src-tauri/src/ops_agent/providers/mod.rs`
- `src-tauri/src/ops_agent/core/llm.rs`

## 7. Stream Event Semantics

Event name:

- `ops-agent-stream`

Payload fields (camelCase):

- `runId`
- `conversationId`
- `stage`
- `chunk`
- `fullAnswer`
- `toolCall`
- `pendingAction`
- `error`
- `createdAt`

Stage values:

- `started`
- `delta`
- `tool_call`
- `tool_read`
- `requires_approval`
- `completed`
- `error`

Stage behavior:

- `started`: marks the active run and resets frontend stream text.
- `delta`: appends streamed answer chunks.
- `tool_call`: streams tool planning state before execution or approval.
- `tool_read`: tells the frontend to reload the conversation because the backend appended a tool message.
- `requires_approval`: carries a pending action payload for approval UI.
- `completed`: ends the run and may carry `fullAnswer` plus the last pending action snapshot.
- `error`: ends the run with an error message.

There is no dedicated `cancelled` stream stage today. Cancellation is surfaced as a completed run with empty answer text.

## 8. Tooling and Approval Model

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
- `src-tauri/src/ops_agent/application/approval.rs`
- `src-tauri/src/ops_agent/infrastructure/store.rs`

## 9. Conversation Compaction

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
- if compacted-away messages referenced images that are no longer kept, the backend also deletes those orphaned attachment files

Result fields returned by the RPC:

- `conversation`
- `compacted`
- `note`
- `estimatedTokensBefore`
- `estimatedTokensAfter`

Important code paths:

- `src-tauri/src/ops_agent/core/compaction.rs`
- `src-tauri/src/ops_agent/application/compaction.rs`

## 10. Persistence and Logs

Persistent files under `.eshell-data/`:

- `ops_agent_conversation_list.json`
- `ops_agent_conversations/<conversation-id>.json`
- `ops_agent_attachments/<attachment-id>.bin`
- `ops_agent_attachments/<attachment-id>.json`
- `ops_agent_debug.log`

Persistence rules:

- conversation summaries, active conversation id, and pending actions are stored in the list file
- full message history for each conversation is stored as a separate JSON document
- image bytes are stored separately from conversation JSON
- user messages only reference images through `attachmentIds`
- pending actions are not stored inside individual conversation files

Runtime-only state:

- run registry and cancellation flags
- current streaming run ownership per conversation

Debug log coverage in `ops_agent_debug.log`:

- shared log context includes `run_id` and `conversation_id` when available
- layer prefixes remain explicit:
  - `application.*` for use-case entry and completion
  - `infrastructure.*` for store mutations, attachment persistence, and state edges
  - `transport.*` for stream event emission
- attachment lifecycle logs now cover save / load / delete operations
- high-level request assembly logs capture user message previews, shell context previews, attachment counts, and native tool-call parsing outcomes
- provider logs capture `api_type`, outbound request metadata, message previews, tool schema previews, non-2xx response previews, and JSON parse failures
- stream logs capture chunk/event progression plus final stream statistics
- compaction logs capture trigger reason, preserved tail sizing, summary source, estimated token deltas, and orphaned attachment cleanup

Important code paths:

- `src-tauri/src/ops_agent/infrastructure/store.rs`
- `src-tauri/src/ops_agent/infrastructure/attachments.rs`
- `src-tauri/src/ops_agent/infrastructure/logging.rs`
- `src-tauri/src/ops_agent/core/llm.rs`
- `src-tauri/src/ops_agent/providers/openai_compat.rs`
- `src-tauri/src/ops_agent/providers/openai_responses.rs`
- `src-tauri/src/ops_agent/providers/anthropic.rs`
- `src-tauri/src/ops_agent/core/compaction.rs`
- `src-tauri/src/ops_agent/infrastructure/run_registry.rs`

## 11. Current Limitations

- Only image attachments are supported today. There is no generalized file attachment model yet.
- Stored attachments are local-first files under `.eshell-data` and are not encrypted.
- Frontend image preview is on-demand by attachment id; there is no inline full-resolution history preload.
- Chat runs are not resumable after app restart.
- Stream cancellation does not have its own stage; consumers must treat empty `completed` events as a cancelled-or-empty terminal state.
- Compaction is destructive by design: older raw messages are replaced by a summary.
- Summary quality depends on the configured model and fallback heuristics.
- AI profile selection is still global. A conversation does not yet pin its own provider or model snapshot.
