# Unreleased Changes

Last updated: 2026-04-19

- Ops Agent now supports image upload in chat, local detached attachment persistence, and click-to-view image preview for sent user messages.
- Ops Agent docs were refreshed to describe the layered package layout, multimodal request flow, and attachment storage model.
- AI provider configuration now supports explicit protocol selection with `openai_chat_completions`, `openai_responses`, and `anthropic_messages`.
- Ops Agent provider dispatch now goes through a shared interface instead of assuming a single OpenAI-compatible wire format.
- AI profile UI now shows provider icons, provider-aware defaults, and theme-aware styling for the chat footer and approval surfaces.
