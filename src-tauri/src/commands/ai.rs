use std::sync::Arc;

use tauri::State;

use crate::ai_service;
use crate::error::to_command_error;
use crate::models::{AiAnswer, AiAskInput};
use crate::state::AppState;

/// Sends question to the configured AI provider.
#[tauri::command]
pub async fn ai_ask(
    state: State<'_, Arc<AppState>>,
    input: AiAskInput,
) -> Result<AiAnswer, String> {
    ai_service::ask_ai(&state, input)
        .await
        .map_err(to_command_error)
}
