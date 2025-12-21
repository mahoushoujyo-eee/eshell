use serde::{Deserialize, Serialize};
use reqwest::Client;

#[derive(Debug, Serialize, Deserialize)]
pub struct AiConfig {
    pub api_key: String,
    pub base_url: String,
    pub model: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct AiRequest {
    pub prompt: String,
    pub context: String,
    pub config: AiConfig,
}

#[tauri::command]
pub async fn ask_ai(request: AiRequest) -> Result<String, String> {
    let client = Client::new();
    let url = format!("{}/chat/completions", request.config.base_url.trim_end_matches('/'));
    
    let body = serde_json::json!({
        "model": request.config.model,
        "messages": [
            {
                "role": "system",
                "content": "You are a helpful assistant for a terminal user. You will be provided with terminal context and a user prompt. Generate the appropriate shell command. Return ONLY the command, no markdown, no explanation."
            },
            {
                "role": "user",
                "content": format!("Context:\n{}\n\nUser Request: {}", request.context, request.prompt)
            }
        ]
    });

    let res = client.post(&url)
        .header("Authorization", format!("Bearer {}", request.config.api_key))
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !res.status().is_success() {
        return Err(format!("API Error: {}", res.status()));
    }

    let json: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
    
    let content = json["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("Error parsing response")
        .to_string();

    Ok(content)
}
