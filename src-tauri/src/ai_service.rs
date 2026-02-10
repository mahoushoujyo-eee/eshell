use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::models::{AiAnswer, AiAskInput, AiConfig, AiChatMessage, AiRole};
use crate::state::AppState;

#[derive(Debug, Serialize)]
struct ChatCompletionsRequest {
    model: String,
    messages: Vec<ChatMessage>,
    temperature: f64,
    max_tokens: u32,
}

#[derive(Debug, Serialize)]
struct ChatMessage {
    role: String,
    content: String,
}

#[derive(Debug, Deserialize)]
struct ChatCompletionsResponse {
    choices: Vec<Choice>,
}

#[derive(Debug, Deserialize)]
struct Choice {
    message: ChoiceMessage,
}

#[derive(Debug, Deserialize)]
struct ChoiceMessage {
    content: String,
}

/// Executes an OpenAI-compatible chat completion request and extracts answer + command hint.
pub async fn ask_ai(state: &AppState, input: AiAskInput) -> AppResult<AiAnswer> {
    if input.question.trim().is_empty() {
        return Err(AppError::Validation("question cannot be empty".to_string()));
    }

    let config = state.storage.get_ai_config();
    ensure_ai_config_is_usable(&config)?;

    let mut user_content = input.question.trim().to_string();
    if input.include_last_output {
        if let Some(session_id) = input.session_id.as_deref() {
            if let Ok(session) = state.get_session(session_id) {
                if !session.last_output.trim().is_empty() {
                    user_content.push_str("\n\nTerminal output context:\n");
                    user_content.push_str(&session.last_output);
                }
            }
        }
    }

    let messages = vec![
        AiChatMessage {
            role: AiRole::System,
            content: config.system_prompt.clone(),
        },
        AiChatMessage {
            role: AiRole::User,
            content: user_content,
        },
    ];

    let response_text = request_completion(&config, &messages).await?;
    Ok(AiAnswer {
        suggested_command: extract_suggested_command(&response_text),
        answer: response_text,
    })
}

async fn request_completion(config: &AiConfig, messages: &[AiChatMessage]) -> AppResult<String> {
    let endpoint = format!(
        "{}/chat/completions",
        config.base_url.trim_end_matches('/')
    );
    let payload = ChatCompletionsRequest {
        model: config.model.clone(),
        messages: messages
            .iter()
            .map(|item| ChatMessage {
                role: ai_role_to_wire(&item.role).to_string(),
                content: item.content.clone(),
            })
            .collect(),
        temperature: config.temperature,
        max_tokens: config.max_tokens,
    };

    let client = reqwest::Client::new();
    let response = client
        .post(endpoint)
        .bearer_auth(&config.api_key)
        .json(&payload)
        .send()
        .await?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(AppError::Runtime(format!(
            "AI request failed: status={status}, body={body}"
        )));
    }

    let body: ChatCompletionsResponse = response.json().await?;
    let answer = body
        .choices
        .first()
        .map(|item| item.message.content.clone())
        .unwrap_or_default();
    if answer.trim().is_empty() {
        return Err(AppError::Runtime(
            "AI response did not contain usable content".to_string(),
        ));
    }

    Ok(answer)
}

fn ensure_ai_config_is_usable(config: &AiConfig) -> AppResult<()> {
    if config.base_url.trim().is_empty() {
        return Err(AppError::Validation("baseUrl cannot be empty".to_string()));
    }
    if config.api_key.trim().is_empty() {
        return Err(AppError::Validation("apiKey cannot be empty".to_string()));
    }
    if config.model.trim().is_empty() {
        return Err(AppError::Validation("model cannot be empty".to_string()));
    }
    Ok(())
}

fn ai_role_to_wire(role: &AiRole) -> &'static str {
    match role {
        AiRole::System => "system",
        AiRole::User => "user",
        AiRole::Assistant => "assistant",
    }
}

fn extract_suggested_command(text: &str) -> Option<String> {
    let mut in_block = false;
    let mut command_lines = Vec::new();

    for line in text.lines() {
        let trimmed = line.trim();

        if trimmed.starts_with("```") {
            if !in_block {
                in_block = true;
                continue;
            }
            break;
        }

        if in_block {
            command_lines.push(line);
        }
    }

    if !command_lines.is_empty() {
        let candidate = command_lines.join("\n").trim().to_string();
        if !candidate.is_empty() {
            return Some(candidate);
        }
    }

    for line in text.lines() {
        let trimmed = line.trim_start();
        if let Some(rest) = trimmed.strip_prefix("$ ") {
            let command = rest.trim();
            if !command.is_empty() {
                return Some(command.to_string());
            }
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_suggested_command_from_fenced_block() {
        let text = "可以执行：\n```bash\nls -la\npwd\n```";
        let command = extract_suggested_command(text).expect("command");
        assert_eq!(command, "ls -la\npwd");
    }

    #[test]
    fn extract_suggested_command_from_prompt_line() {
        let text = "先检查：\n$ df -h";
        let command = extract_suggested_command(text).expect("command");
        assert_eq!(command, "df -h");
    }
}
