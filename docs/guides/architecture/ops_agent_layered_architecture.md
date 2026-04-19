# Ops Agent Layered Architecture

This document describes the current layered layout of `src-tauri/src/ops_agent/` after the provider abstraction work, multimodal input support, and attachment persistence split.

Reference layers:

1. Interaction
2. Application
3. Core
4. Tools
5. Provider / Transport
6. Infrastructure
7. Domain

## 1. Package Map

```text
src-tauri/src/ops_agent/
|- application/
|  |- approval.rs
|  |- attachments.rs
|  |- chat.rs
|  |- compaction.rs
|  |- mod.rs
|  `- tests.rs
|- core/
|  |- compaction.rs
|  |- helpers.rs
|  |- llm.rs
|  |- mod.rs
|  |- prompting.rs
|  |- react_loop.rs
|  `- runtime.rs
|- domain/
|  |- mod.rs
|  `- types.rs
|- infrastructure/
|  |- attachments.rs
|  |- logging.rs
|  |- mod.rs
|  |- run_registry.rs
|  `- store.rs
|- providers/
|  |- anthropic.rs
|  |- mod.rs
|  |- openai_compat.rs
|  |- openai_responses.rs
|  |- text_fallback.rs
|  `- types.rs
|- tools/
|  |- mod.rs
|  `- shell.rs
|- transport/
|  |- events.rs
|  |- mod.rs
|  `- stream.rs
`- mod.rs
```

## 2. Layer Responsibilities

### Interaction

Responsibilities:

- receives user text, shell context, and image attachments
- renders stream deltas, tool states, and approval cards
- lets the user switch the active AI profile
- lets the user choose provider protocol type in the profile editor

Main entry points:

- `src/components/panels/ai-assistant/*`
- `src/components/sidebar/AiConfigModal.jsx`
- `src/hooks/workbench/operations.js`
- `src/hooks/workbench/aiProfiles.js`
- `src/lib/tauri-api.js`

### Application

Responsibilities:

- conversation CRUD
- starting and resuming chat runs
- attachment readback for image preview
- approval resolution
- manual conversation compaction

Main files:

- `application/chat.rs`
- `application/approval.rs`
- `application/attachments.rs`
- `application/compaction.rs`

### Core

Responsibilities:

- prompt assembly
- request planning and final-answer generation
- retry handling
- auto-compaction
- run lifecycle orchestration

Main files:

- `core/prompting.rs`
- `core/llm.rs`
- `core/react_loop.rs`
- `core/runtime.rs`
- `core/compaction.rs`

Important runtime detail:

- `react_loop.rs` reads `AiConfig` once at run start
- changing the active AI profile during streaming affects the next request only

### Tools

Responsibilities:

- tool registry
- tool execution
- risk classification and approval gating

Main files:

- `tools/mod.rs`
- `tools/shell.rs`

### Provider / Transport

Responsibilities:

- translate internal chat history into vendor-specific wire format
- issue blocking or streaming HTTP calls
- parse tool calls and streamed text deltas
- normalize provider responses back to shared internal structures

Main files:

- `providers/mod.rs`
- `providers/types.rs`
- `providers/openai_compat.rs`
- `providers/openai_responses.rs`
- `providers/anthropic.rs`
- `transport/events.rs`
- `transport/stream.rs`

Provider dispatch is selected by `AiConfig.apiType`:

- `openai_chat_completions`
- `openai_responses`
- `anthropic_messages`

### Infrastructure

Responsibilities:

- conversation persistence
- detached attachment persistence
- debug logging
- active run registry
- AI profile persistence

Main files:

- `infrastructure/store.rs`
- `infrastructure/attachments.rs`
- `infrastructure/logging.rs`
- `infrastructure/run_registry.rs`
- `src-tauri/src/storage/ai_profiles.rs`

### Domain

Responsibilities:

- stable shared data structures
- layer-neutral message, conversation, attachment, and tool-call types

Main files:

- `domain/types.rs`

## 3. Provider Abstraction

`providers/mod.rs` is now the provider interface boundary for `ops_agent`.

Shared contract:

- input: `Vec<ProviderChatMessage>`
- options: `ProviderChatRequestOptions`
- output: `ProviderChatMessageResponse`

Current implementations:

- `openai_compat.rs` for Chat Completions compatible vendors
- `openai_responses.rs` for OpenAI Responses compatible vendors
- `anthropic.rs` for Anthropic Messages compatible vendors

This keeps `core/llm.rs` and `core/react_loop.rs` independent from vendor wire format.

## 4. Multimodal Message Path

Flow:

1. The frontend sends `imageAttachments` in the chat request.
2. `application/chat.rs` stores binary payloads through `infrastructure/attachments.rs`.
3. Conversation history stores only `attachmentIds`.
4. `core/llm.rs` reads those attachments back when preparing provider history.
5. Provider transports serialize them into image-capable request parts.

Important consequence:

- attachments are detached in persistence, but rehydrated into model input at request time

## 5. AI Profile Model

AI profile persistence lives outside `ops_agent`, but it directly affects provider dispatch.

Stored fields now include:

- `id`
- `name`
- `apiType`
- `baseUrl`
- `apiKey`
- `model`
- `systemPrompt`
- `temperature`
- `maxTokens`
- `maxContextTokens`

Global fields in `AiProfilesState`:

- `activeProfileId`
- `approvalMode`

Current limitation:

- profile selection is global to the app, not pinned per conversation

## 6. Logging Boundaries

Debug logs in `.eshell-data/ops_agent_debug.log` should make it possible to reconstruct:

- request assembly
- provider selection and request kind
- stream progress
- compaction decisions
- attachment save/load/delete lifecycle

Useful prefixes:

- `application.*`
- `run.*`
- `react.*`
- `ai.provider.*`
- `transport.*`
- `compact.*`
- `infrastructure.attachments.*`

## 7. Dependency Direction

Recommended dependency direction:

```text
frontend / commands
  -> application
  -> core
  -> tools
  -> providers + transport
  -> infrastructure
  -> domain
```

Rules:

- `application` may depend on `core`, `tools`, `infrastructure`, and `domain`
- `core` may depend on `providers`, `transport`, `infrastructure`, and `domain`
- `providers` should not depend on `application`
- `tools` should not depend on `application`
- `domain` should stay free of transport or storage code

## 8. Follow-up Refactors

Likely next cleanup steps:

1. Split `tools/shell.rs` into validation, risk, and execution slices.
2. Split `core/llm.rs` into history serialization, planner request, and final-answer request helpers.
3. Add attachment count and size limits at the application boundary.
4. If non-image attachments are added later, extract a dedicated attachment subdomain instead of widening generic message types indefinitely.
