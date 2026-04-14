use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::models::{AiAnswer, AiAskInput, AiChatMessage, AiConfig, AiRole};
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
    let endpoint = format!("{}/chat/completions", config.base_url.trim_end_matches('/'));
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
    use crate::models::{now_rfc3339, AiAskInput, AiProfile, AiProfileInput, ShellSession};
    use crate::state::AppState;
    use serde_json::Value;
    use std::env;
    use std::fs;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::path::PathBuf;
    use std::sync::mpsc;
    use std::thread;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    #[derive(Debug)]
    struct CapturedHttpRequest {
        path: String,
        authorization: Option<String>,
        body_json: Value,
    }

    fn temp_dir(name: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock drift")
            .as_nanos();
        env::temp_dir().join(format!("eshell-ai-service-{name}-{stamp}"))
    }

    fn is_usable_profile(profile: &AiProfile) -> bool {
        !profile.base_url.trim().is_empty()
            && !profile.api_key.trim().is_empty()
            && !profile.model.trim().is_empty()
            && (0.0..=2.0).contains(&profile.temperature)
            && profile.max_tokens > 0
            && profile.max_context_tokens > 0
    }

    fn find_header_end(bytes: &[u8]) -> Option<usize> {
        bytes
            .windows(4)
            .position(|window| window == b"\r\n\r\n")
            .map(|index| index + 4)
    }

    fn parse_content_length(headers: &str) -> usize {
        headers
            .lines()
            .find_map(|line| {
                let (name, value) = line.split_once(':')?;
                if name.trim().eq_ignore_ascii_case("content-length") {
                    return value.trim().parse::<usize>().ok();
                }
                None
            })
            .unwrap_or(0)
    }

    fn parse_authorization(headers: &str) -> Option<String> {
        headers.lines().find_map(|line| {
            let (name, value) = line.split_once(':')?;
            if name.trim().eq_ignore_ascii_case("authorization") {
                return Some(value.trim().to_string());
            }
            None
        })
    }

    fn parse_request_path(headers: &str) -> String {
        let request_line = headers.lines().next().unwrap_or_default();
        request_line
            .split_whitespace()
            .nth(1)
            .unwrap_or_default()
            .to_string()
    }

    fn start_mock_chat_server(
        response_json: &'static str,
    ) -> (String, mpsc::Receiver<CapturedHttpRequest>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock server");
        let address = listener.local_addr().expect("mock server address");
        let (tx, rx) = mpsc::channel();

        thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept mock request");
            let mut request_bytes = Vec::new();
            let mut chunk = [0_u8; 4096];

            let header_end = loop {
                let read = stream.read(&mut chunk).expect("read request headers");
                if read == 0 {
                    panic!("mock server received empty request");
                }
                request_bytes.extend_from_slice(&chunk[..read]);
                if let Some(end) = find_header_end(&request_bytes) {
                    break end;
                }
            };

            let headers_text = String::from_utf8_lossy(&request_bytes[..header_end]).to_string();
            let content_length = parse_content_length(&headers_text);
            let mut body_bytes = request_bytes[header_end..].to_vec();

            while body_bytes.len() < content_length {
                let read = stream.read(&mut chunk).expect("read request body");
                if read == 0 {
                    break;
                }
                body_bytes.extend_from_slice(&chunk[..read]);
            }
            body_bytes.truncate(content_length);

            let captured = CapturedHttpRequest {
                path: parse_request_path(&headers_text),
                authorization: parse_authorization(&headers_text),
                body_json: serde_json::from_slice::<Value>(&body_bytes).unwrap_or(Value::Null),
            };
            tx.send(captured).expect("send captured request");

            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                response_json.len(),
                response_json
            );
            stream
                .write_all(response.as_bytes())
                .expect("write mock response");
            let _ = stream.flush();
        });

        (format!("http://{address}"), rx)
    }

    #[test]
    fn extract_suggested_command_from_fenced_block() {
        let text = "Try this:\n```bash\nls -la\npwd\n```";
        let command = extract_suggested_command(text).expect("command");
        assert_eq!(command, "ls -la\npwd");
    }

    #[test]
    fn extract_suggested_command_from_prompt_line() {
        let text = "Run this first:\n$ df -h";
        let command = extract_suggested_command(text).expect("command");
        assert_eq!(command, "df -h");
    }

    #[test]
    fn ask_ai_uses_active_profile_and_attaches_terminal_context() {
        let (base_url, captured_request_rx) = start_mock_chat_server(
            r#"{"choices":[{"message":{"content":"Use:\n```bash\nsystemctl status nginx\n```"}}]}"#,
        );

        let state = AppState::new(temp_dir("ask-ai")).expect("create app state");
        let saved = state
            .storage
            .save_ai_profile(AiProfileInput {
                id: None,
                name: "ArkDefault".to_string(),
                base_url,
                api_key: "test-api-key".to_string(),
                model: "doubao-seed-2-0-lite-260215".to_string(),
                system_prompt: "You are a Linux operations assistant. Return concise answers and include safe shell commands when needed.".to_string(),
                temperature: 0.2,
                max_tokens: 100000,
                max_context_tokens: 100000,
            })
            .expect("save profile");
        let profile_id = saved
            .profiles
            .iter()
            .find(|item| item.name == "ArkDefault")
            .expect("new profile")
            .id
            .clone();
        state
            .storage
            .set_active_ai_profile(&profile_id)
            .expect("activate profile");

        let now = now_rfc3339();
        state.put_session(ShellSession {
            id: "session-1".to_string(),
            config_id: "config-1".to_string(),
            config_name: "prod".to_string(),
            current_dir: "/opt/service".to_string(),
            last_output: "nginx.service: Failed with result 'exit-code'.".to_string(),
            created_at: now.clone(),
            updated_at: now,
        });

        let answer = tauri::async_runtime::block_on(ask_ai(
            &state,
            AiAskInput {
                session_id: Some("session-1".to_string()),
                question: "How should I debug nginx startup failure?".to_string(),
                include_last_output: true,
            },
        ))
        .expect("ask ai");

        assert_eq!(
            answer.suggested_command.as_deref(),
            Some("systemctl status nginx")
        );
        assert!(answer.answer.contains("systemctl status nginx"));

        let captured = captured_request_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("captured request");
        assert_eq!(captured.path, "/chat/completions");
        assert_eq!(
            captured.authorization.as_deref(),
            Some("Bearer test-api-key")
        );
        assert_eq!(captured.body_json["model"], "doubao-seed-2-0-lite-260215");
        assert_eq!(captured.body_json["temperature"], 0.2);
        assert_eq!(captured.body_json["max_tokens"], 100000);

        let messages = captured.body_json["messages"]
            .as_array()
            .expect("messages array");
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0]["role"], "system");
        assert_eq!(
            messages[0]["content"],
            "You are a Linux operations assistant. Return concise answers and include safe shell commands when needed."
        );

        let user_content = messages[1]["content"].as_str().expect("user message");
        assert!(user_content.contains("How should I debug nginx startup failure?"));
        assert!(user_content.contains("Terminal output context:"));
        assert!(user_content.contains("Failed with result 'exit-code'."));
    }

    #[test]
    #[ignore = "Optional live smoke test; run with ESHELL_RUN_LIVE_AI_SMOKE=1"]
    fn live_smoke_uses_first_usable_profile() {
        if env::var("ESHELL_RUN_LIVE_AI_SMOKE").ok().as_deref() != Some("1") {
            eprintln!("Skipping live smoke test; set ESHELL_RUN_LIVE_AI_SMOKE=1 to run.");
            return;
        }

        let source_profiles = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join(".eshell-data")
            .join("ai_profiles.json");
        if !source_profiles.exists() {
            eprintln!(
                "Skipping live smoke test: {} not found.",
                source_profiles.display()
            );
            return;
        }

        let root = temp_dir("live-ai-smoke");
        fs::create_dir_all(&root).expect("create temp root");
        fs::copy(&source_profiles, root.join("ai_profiles.json")).expect("copy ai profiles");

        let state = AppState::new(root).expect("create app state");
        let profiles = state.storage.list_ai_profiles();
        let selected = profiles
            .profiles
            .iter()
            .find(|item| is_usable_profile(item))
            .cloned();
        let Some(selected_profile) = selected else {
            eprintln!(
                "Skipping live smoke test: no usable profile found in {}.",
                source_profiles.display()
            );
            return;
        };

        state
            .storage
            .set_active_ai_profile(&selected_profile.id)
            .expect("activate selected profile");
        let config = state.storage.get_ai_config();
        assert_eq!(
            config.base_url,
            selected_profile.base_url.trim_end_matches('/')
        );
        assert_eq!(config.model, selected_profile.model);

        let answer = tauri::async_runtime::block_on(ask_ai(
            &state,
            AiAskInput {
                session_id: None,
                question: "Reply with one safe command to list current directory.".to_string(),
                include_last_output: false,
            },
        ))
        .expect("live ask_ai");

        assert!(!answer.answer.trim().is_empty());
    }
}
