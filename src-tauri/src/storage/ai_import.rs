use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::error::{AppError, AppResult};
use crate::models::{
    AiApiType, AiImportCandidate, AiImportSource, AiImportSourceKind, AiProfile, AiProfileInput,
    AiProfilesState,
};

const MAX_CANDIDATES_PER_SOURCE: usize = 32;
const DEFAULT_SYSTEM_PROMPT: &str =
    "You are a Linux operations assistant. Return concise answers and include safe shell commands when needed.";

#[derive(Debug, Deserialize)]
struct ClaudeSettingsFile {
    #[serde(default)]
    env: Option<serde_json::Value>,
    #[serde(default)]
    api_key_helper: Option<String>,
    #[serde(default)]
    api_key: Option<String>,
}

#[derive(Debug, Deserialize)]
struct CodexConfigFile {
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    base_url: Option<String>,
    #[serde(default)]
    model_provider: Option<String>,
    #[serde(default)]
    requires_openai_auth: Option<bool>,
    #[serde(default)]
    wire_api: Option<String>,
    #[serde(default)]
    model_providers: Option<serde_json::Value>,
    #[serde(default)]
    shell_environment_policy: Option<CodexShellEnvPolicy>,
}

#[derive(Debug, Deserialize)]
struct CodexShellEnvPolicy {
    #[serde(default)]
    set: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
struct OpenAiJsonFile {
    #[serde(default, alias = "apiKey")]
    api_key: Option<String>,
    #[serde(default, alias = "baseUrl")]
    base_url: Option<String>,
    #[serde(default, alias = "modelId")]
    model: Option<String>,
}

pub fn list_ai_import_sources(custom_paths: &[String]) -> Vec<AiImportSource> {
    let mut sources = Vec::new();
    let mut seen_paths: HashSet<PathBuf> = HashSet::new();

    for (kind, label, subdir, file_name) in [
        (
            AiImportSourceKind::ClaudeCode,
            "Claude Code",
            Some(".claude"),
            "settings.json",
        ),
        (
            AiImportSourceKind::Codex,
            "Codex",
            Some(".codex"),
            "config.toml",
        ),
    ] {
        let candidate_paths = collect_candidate_paths(subdir, file_name);
        if candidate_paths.is_empty() {
            sources.push(make_unavailable_source(kind, label));
            continue;
        }

        let total = candidate_paths.len();
        for path in candidate_paths {
            if !seen_paths.insert(path.clone()) {
                continue;
            }
            let display_label = if total == 1 {
                label.to_string()
            } else {
                format!("{label} ({})", path.display())
            };
            match fs::metadata(&path) {
                Ok(meta) if meta.is_file() => sources.push(AiImportSource {
                    id: source_id(&kind, &path),
                    kind: kind.clone(),
                    label: display_label,
                    path: path.to_string_lossy().to_string(),
                    available: true,
                    note: None,
                }),
                Ok(_) => sources.push(make_unavailable_source_with_path(
                    &kind,
                    &display_label,
                    &path,
                    "not a regular file",
                )),
                Err(err) => sources.push(make_unavailable_source_with_path(
                    &kind,
                    &display_label,
                    &path,
                    &err.to_string(),
                )),
            }
        }
    }

    for raw in custom_paths {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            continue;
        }
        let path = PathBuf::from(trimmed);
        if !seen_paths.insert(path.clone()) {
            continue;
        }
        let label = format!("Custom ({})", path.display());
        match fs::metadata(&path) {
            Ok(meta) if meta.is_file() => sources.push(AiImportSource {
                id: source_id(&AiImportSourceKind::CustomJson, &path),
                kind: AiImportSourceKind::CustomJson,
                label,
                path: path.to_string_lossy().to_string(),
                available: true,
                note: None,
            }),
            Ok(_) => sources.push(make_unavailable_source_with_path(
                &AiImportSourceKind::CustomJson,
                &label,
                &path,
                "not a regular file",
            )),
            Err(err) => sources.push(make_unavailable_source_with_path(
                &AiImportSourceKind::CustomJson,
                &label,
                &path,
                &err.to_string(),
            )),
        }
    }

    sources
}

pub fn detect_ai_import_candidates(
    source: &AiImportSource,
) -> AppResult<(Vec<AiImportCandidate>, Vec<String>)> {
    if !source.available {
        return Err(AppError::Validation(format!(
            "source {} is not available: {}",
            source.label,
            source.note.clone().unwrap_or_default()
        )));
    }

    let path = PathBuf::from(&source.path);
    let raw = fs::read_to_string(&path)
        .map_err(|err| AppError::Runtime(format!("failed to read {}: {err}", path.display())))?;

    let mut warnings = Vec::new();
    let candidates = match source.kind {
        AiImportSourceKind::ClaudeCode => parse_claude_settings(&raw, source, &mut warnings),
        AiImportSourceKind::Codex => parse_codex_config(&raw, source, &mut warnings),
        AiImportSourceKind::CustomJson => parse_custom_json(&raw, source, &mut warnings),
    };

    if candidates.len() > MAX_CANDIDATES_PER_SOURCE {
        warnings.push(format!(
            "truncated to {MAX_CANDIDATES_PER_SOURCE} entries (file has more)"
        ));
    }

    Ok((candidates, warnings))
}

pub fn merge_imported_profiles(
    state: &mut AiProfilesState,
    candidates: Vec<AiImportCandidate>,
) -> AppResult<(Vec<AiProfile>, Vec<String>)> {
    let mut imported = Vec::new();
    let mut skipped = Vec::new();
    let mut existing_keys: HashSet<String> = state
        .profiles
        .iter()
        .map(|profile| dedup_key(&profile.api_type, &profile.base_url, &profile.model))
        .collect();

    for candidate in candidates {
        let Some(input) = candidate_to_profile_input(&candidate) else {
            skipped.push(format!("{}: missing required fields", candidate.name));
            continue;
        };

        let key = dedup_key(&input.api_type, &input.base_url, &input.model);
        if existing_keys.contains(&key) {
            skipped.push(format!(
                "{}: duplicate of existing profile ({} / {})",
                candidate.name, candidate.base_url, candidate.model
            ));
            continue;
        }

        match create_profile_from_input(&input) {
            Ok(profile) => {
                existing_keys.insert(key);
                imported.push(profile);
            }
            Err(err) => {
                skipped.push(format!("{}: {err}", candidate.name));
            }
        }
    }

    if !imported.is_empty() {
        for profile in &imported {
            if !state.profiles.iter().any(|item| item.id == profile.id) {
                state.profiles.push(profile.clone());
            }
        }
        if state.active_profile_id.is_none() {
            if let Some(first) = imported.first() {
                state.active_profile_id = Some(first.id.clone());
            }
        }
    }

    Ok((imported, skipped))
}

pub fn create_profile_from_input(input: &AiProfileInput) -> AppResult<AiProfile> {
    use crate::storage::ai_profiles::profile_from_input_for_import;
    profile_from_input_for_import(input)
}

fn candidate_to_profile_input(candidate: &AiImportCandidate) -> Option<AiProfileInput> {
    let base_url = candidate.base_url.trim();
    let model = candidate.model.trim();
    if base_url.is_empty() || model.is_empty() {
        return None;
    }

    Some(AiProfileInput {
        id: None,
        name: candidate.name.trim().to_string(),
        api_type: candidate.api_type.clone(),
        base_url: base_url.to_string(),
        api_key: candidate.api_key.trim().to_string(),
        model: model.to_string(),
        system_prompt: candidate.system_prompt.trim().to_string(),
        temperature: candidate.temperature,
        max_tokens: candidate.max_tokens,
        max_context_tokens: candidate.max_context_tokens,
    })
}

fn parse_claude_settings(
    raw: &str,
    source: &AiImportSource,
    warnings: &mut Vec<String>,
) -> Vec<AiImportCandidate> {
    let parsed: ClaudeSettingsFile = match serde_json::from_str(raw) {
        Ok(value) => value,
        Err(err) => {
            warnings.push(format!("Claude Code settings JSON parse error: {err}"));
            return Vec::new();
        }
    };

    let mut notes = Vec::new();
    let api_key = pick_env_value(parsed.env.as_ref(), "ANTHROPIC_AUTH_TOKEN")
        .or_else(|| pick_env_value(parsed.env.as_ref(), "ANTHROPIC_API_KEY"))
        .or_else(|| parsed.api_key_helper.clone())
        .or_else(|| parsed.api_key.clone())
        .unwrap_or_default();
    if api_key.is_empty() {
        notes.push("No API key found (ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY / apiKeyHelper).".to_string());
    }

    let base_url = pick_env_value(parsed.env.as_ref(), "ANTHROPIC_BASE_URL")
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "https://api.anthropic.com".to_string());

    let model = pick_env_value(parsed.env.as_ref(), "ANTHROPIC_MODEL")
        .or_else(|| pick_env_value(parsed.env.as_ref(), "ANTHROPIC_DEFAULT_OPUS_MODEL"))
        .or_else(|| pick_env_value(parsed.env.as_ref(), "ANTHROPIC_DEFAULT_SONNET_MODEL"))
        .or_else(|| pick_env_value(parsed.env.as_ref(), "ANTHROPIC_DEFAULT_HAIKU_MODEL"))
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "claude-3-5-sonnet-latest".to_string());

    vec![AiImportCandidate {
        source_id: source.id.clone(),
        source_kind: source.kind.clone(),
        source_label: source.label.clone(),
        source_path: source.path.clone(),
        name: format!("Claude Code ({} / {})", source.label, model),
        api_type: AiApiType::AnthropicMessages,
        base_url: normalize_base_url(&base_url),
        api_key: api_key.clone(),
        model,
        temperature: 0.2,
        max_tokens: 800,
        max_context_tokens: 100_000,
        system_prompt: DEFAULT_SYSTEM_PROMPT.to_string(),
        notes,
    }]
}

fn parse_codex_config(
    raw: &str,
    source: &AiImportSource,
    warnings: &mut Vec<String>,
) -> Vec<AiImportCandidate> {
    let parsed: CodexConfigFile = match toml_basic::from_str(raw) {
        Ok(value) => value,
        Err(err) => {
            warnings.push(format!("Codex config TOML parse error: {err}"));
            return Vec::new();
        }
    };

    let env_set = parsed
        .shell_environment_policy
        .as_ref()
        .and_then(|policy| policy.set.as_ref())
        .and_then(|value| value.as_object())
        .cloned();

    let active_provider_name = parsed.model_provider.clone();
    let providers_map = parsed
        .model_providers
        .as_ref()
        .and_then(|value| value.as_object())
        .cloned();

    let active_provider = active_provider_name
        .as_ref()
        .and_then(|name| providers_map.as_ref().and_then(|map| map.get(name)))
        .and_then(|value| value.as_object());

    let default_model = parsed
        .model
        .clone()
        .or_else(|| env_value(&env_set, "ANTHROPIC_MODEL"))
        .unwrap_or_default();

    let default_base_url = parsed
        .base_url
        .clone()
        .or_else(|| env_value(&env_set, "ANTHROPIC_BASE_URL"))
        .or_else(|| {
            active_provider
                .and_then(|map| map.get("base_url"))
                .and_then(value_to_string)
        })
        .unwrap_or_default();

    let default_api_key = env_value(&env_set, "ANTHROPIC_AUTH_TOKEN")
        .or_else(|| env_value(&env_set, "OPENAI_API_KEY"))
        .or_else(|| {
            active_provider
                .and_then(|map| map.get("api_key"))
                .and_then(value_to_string)
        })
        .unwrap_or_default();

    let requires_openai_auth = parsed.requires_openai_auth.unwrap_or(false);
    let wire_api = parsed.wire_api.clone().unwrap_or_default();

    let mut candidates = Vec::new();
    let mut used_names: HashSet<String> = HashSet::new();

    if let Some(model) = parsed.model.clone().filter(|value| !value.trim().is_empty()) {
        let mut notes = Vec::new();
        if default_api_key.is_empty() {
            notes.push(
                "No OPENAI_API_KEY/ANTHROPIC_AUTH_TOKEN found in [shell_environment_policy.set]."
                    .to_string(),
            );
        }
        if default_base_url.is_empty() {
            notes.push("No base URL found; will use provider default.".to_string());
        }
        let api_type = infer_codex_api_type(requires_openai_auth, &wire_api);
        let name = format!("Codex (default / {model})");
        used_names.insert(name.clone());
        candidates.push(AiImportCandidate {
            source_id: source.id.clone(),
            source_kind: source.kind.clone(),
            source_label: source.label.clone(),
            source_path: source.path.clone(),
            name,
            api_type,
            base_url: normalize_base_url(&default_base_url),
            api_key: default_api_key.clone(),
            model,
            temperature: 0.2,
            max_tokens: 800,
            max_context_tokens: 100_000,
            system_prompt: DEFAULT_SYSTEM_PROMPT.to_string(),
            notes,
        });
    }

    if let Some(map) = parsed
        .model_providers
        .as_ref()
        .and_then(|value| value.as_object())
    {
        for (provider_name, provider_value) in map {
            if candidates.len() >= MAX_CANDIDATES_PER_SOURCE {
                break;
            }
            let Some(provider_obj) = provider_value.as_object() else {
                continue;
            };
            let base_url = provider_obj
                .get("base_url")
                .and_then(value_to_string)
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| default_base_url.clone());
            let provider_wire_api = provider_obj
                .get("wire_api")
                .and_then(value_to_string)
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| wire_api.clone());
            let provider_requires_openai_auth = provider_obj
                .get("requires_openai_auth")
                .and_then(value_as_bool)
                .unwrap_or(requires_openai_auth);
            let api_key = provider_obj
                .get("api_key")
                .and_then(value_to_string)
                .filter(|value| !value.trim().is_empty())
                .or_else(|| {
                    if default_api_key.is_empty() {
                        None
                    } else {
                        Some(default_api_key.clone())
                    }
                })
                .unwrap_or_default();
            let model = default_model.clone();
            if model.trim().is_empty() {
                continue;
            }
            if base_url.trim().is_empty() {
                warnings.push(format!(
                    "Codex provider {provider_name} is missing base_url; skipped."
                ));
                continue;
            }
            let mut notes = Vec::new();
            if api_key.is_empty() {
                notes.push("No api_key defined for this provider.".to_string());
            }
            let api_type = infer_codex_api_type(provider_requires_openai_auth, &provider_wire_api);
            let mut name = format!("Codex ({provider_name} / {model})");
            while used_names.contains(&name) {
                name.push('+');
            }
            used_names.insert(name.clone());
            candidates.push(AiImportCandidate {
                source_id: source.id.clone(),
                source_kind: source.kind.clone(),
                source_label: source.label.clone(),
                source_path: source.path.clone(),
                name,
                api_type,
                base_url: normalize_base_url(&base_url),
                api_key,
                model,
                temperature: 0.2,
                max_tokens: 800,
                max_context_tokens: 100_000,
                system_prompt: DEFAULT_SYSTEM_PROMPT.to_string(),
                notes,
            });
        }
    }

    if candidates.is_empty() {
        warnings.push("Codex config did not declare a model or providers.".to_string());
    }

    candidates
}

fn parse_custom_json(
    raw: &str,
    source: &AiImportSource,
    warnings: &mut Vec<String>,
) -> Vec<AiImportCandidate> {
    let value: serde_json::Value = match serde_json::from_str(raw) {
        Ok(value) => value,
        Err(err) => {
            warnings.push(format!("JSON parse error: {err}"));
            return Vec::new();
        }
    };

    if let Ok(file) = serde_json::from_value::<OpenAiJsonFile>(value.clone()) {
        let api_key = file
            .api_key
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_default();
        let base_url = file
            .base_url
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_default();
        let model = file
            .model
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_default();
        let mut notes = Vec::new();
        if api_key.is_empty() {
            notes.push("No apiKey field found.".to_string());
        }
        if base_url.is_empty() {
            notes.push("No baseUrl field found; will use provider default.".to_string());
        }
        if model.is_empty() {
            notes.push("No model field found.".to_string());
        }
        let api_type = if base_url.contains("anthropic.com") {
            AiApiType::AnthropicMessages
        } else {
            AiApiType::OpenAiChatCompletions
        };
        return vec![AiImportCandidate {
            source_id: source.id.clone(),
            source_kind: source.kind.clone(),
            source_label: source.label.clone(),
            source_path: source.path.clone(),
            name: format!("Custom ({}/{})", source_path_file_name(&source.path), model),
            api_type,
            base_url: normalize_base_url(&base_url),
            api_key,
            model,
            temperature: 0.2,
            max_tokens: 800,
            max_context_tokens: 100_000,
            system_prompt: DEFAULT_SYSTEM_PROMPT.to_string(),
            notes,
        }];
    }

    let mut notes = Vec::new();
    notes.push("JSON file did not match the documented schema; using heuristics.".to_string());
    let api_key = value
        .get("apiKey")
        .or_else(|| value.get("api_key"))
        .and_then(value_to_string)
        .unwrap_or_default();
    let base_url = value
        .get("baseUrl")
        .or_else(|| value.get("base_url"))
        .and_then(value_to_string)
        .unwrap_or_default();
    let model = value
        .get("model")
        .or_else(|| value.get("modelId"))
        .and_then(value_to_string)
        .unwrap_or_default();
    let api_type = if base_url.contains("anthropic.com") {
        AiApiType::AnthropicMessages
    } else {
        AiApiType::OpenAiChatCompletions
    };
    vec![AiImportCandidate {
        source_id: source.id.clone(),
        source_kind: source.kind.clone(),
        source_label: source.label.clone(),
        source_path: source.path.clone(),
        name: format!("Custom ({})", source_path_file_name(&source.path)),
        api_type,
        base_url: normalize_base_url(&base_url),
        api_key,
        model,
        temperature: 0.2,
        max_tokens: 800,
        max_context_tokens: 100_000,
        system_prompt: DEFAULT_SYSTEM_PROMPT.to_string(),
        notes,
    }]
}

fn infer_codex_api_type(requires_openai_auth: bool, wire_api: &str) -> AiApiType {
    let wire = wire_api.trim().to_ascii_lowercase();
    if wire == "responses" {
        AiApiType::OpenAiResponses
    } else if wire == "chat" || requires_openai_auth {
        AiApiType::OpenAiChatCompletions
    } else {
        AiApiType::AnthropicMessages
    }
}

fn pick_env_value(value: Option<&serde_json::Value>, key: &str) -> Option<String> {
    let map = value?.as_object()?;
    map.get(key).and_then(value_to_string)
}

fn env_value(map: &Option<serde_json::Map<String, serde_json::Value>>, key: &str) -> Option<String> {
    map.as_ref()?.get(key).and_then(value_to_string)
}

fn value_to_string(value: &serde_json::Value) -> Option<String> {
    match value {
        serde_json::Value::String(text) => Some(text.clone()),
        serde_json::Value::Number(number) => Some(number.to_string()),
        serde_json::Value::Bool(flag) => Some(flag.to_string()),
        _ => None,
    }
}

fn value_as_bool(value: &serde_json::Value) -> Option<bool> {
    match value {
        serde_json::Value::Bool(flag) => Some(*flag),
        serde_json::Value::String(text) => match text.trim().to_ascii_lowercase().as_str() {
            "true" | "1" | "yes" => Some(true),
            "false" | "0" | "no" => Some(false),
            _ => None,
        },
        _ => None,
    }
}

fn dedup_key(api_type: &AiApiType, base_url: &str, model: &str) -> String {
    format!(
        "{}|{}|{}",
        serde_json::to_string(api_type).unwrap_or_default(),
        base_url.trim().to_ascii_lowercase(),
        model.trim().to_ascii_lowercase()
    )
}

fn normalize_base_url(value: &str) -> String {
    value.trim().trim_end_matches('/').to_string()
}

fn source_id(kind: &AiImportSourceKind, path: &Path) -> String {
    let raw = path.to_string_lossy().to_string();
    let prefix = match kind {
        AiImportSourceKind::ClaudeCode => "claude",
        AiImportSourceKind::Codex => "codex",
        AiImportSourceKind::CustomJson => "custom",
    };
    format!("{prefix}:{raw}")
}

fn make_unavailable_source(kind: AiImportSourceKind, label: &str) -> AiImportSource {
    AiImportSource {
        id: format!("{kind:?}:missing"),
        kind,
        label: label.to_string(),
        path: String::new(),
        available: false,
        note: Some("not found in known locations".to_string()),
    }
}

fn make_unavailable_source_with_path(
    kind: &AiImportSourceKind,
    label: &str,
    path: &Path,
    reason: &str,
) -> AiImportSource {
    AiImportSource {
        id: source_id(kind, path),
        kind: kind.clone(),
        label: label.to_string(),
        path: path.to_string_lossy().to_string(),
        available: false,
        note: Some(reason.to_string()),
    }
}

fn source_path_file_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .and_then(|item| item.to_str())
        .map(|item| item.to_string())
        .unwrap_or_else(|| path.to_string())
}

fn collect_candidate_paths(subdir: Option<&str>, file_name: &str) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    let Some(home) = resolve_home_dir() else {
        return paths;
    };
    let Some(subdir) = subdir else {
        return paths;
    };
    let direct = home.join(subdir).join(file_name);
    if direct.exists() || direct.parent().map(|parent| parent.exists()).unwrap_or(false) {
        paths.push(direct);
    }
    if cfg!(target_os = "macos") || cfg!(target_os = "linux") {
        let xdg_config = std::env::var("XDG_CONFIG_HOME")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".config"));
        let alt = xdg_config.join(subdir).join(file_name);
        if alt.exists() && !paths.iter().any(|existing| existing == &alt) {
            paths.push(alt);
        }
    }
    paths
}

fn resolve_home_dir() -> Option<PathBuf> {
    if let Ok(value) = std::env::var("HOMEDRIVE") {
        if let Ok(home_path) = std::env::var("HOMEPATH") {
            let combined = format!("{value}{home_path}");
            if !combined.trim().is_empty() {
                return Some(PathBuf::from(combined));
            }
        }
    }
    for key in ["HOME", "USERPROFILE"] {
        if let Ok(value) = std::env::var(key) {
            if !value.trim().is_empty() {
                return Some(PathBuf::from(value));
            }
        }
    }
    None
}

pub fn read_custom_path_for_detection(path: &str) -> AppResult<()> {
    const MAX_CUSTOM_FILE_BYTES: u64 = 4 * 1024 * 1024;
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(AppError::Validation("custom path cannot be empty".to_string()));
    }
    let metadata = fs::metadata(trimmed)?;
    if !metadata.is_file() {
        return Err(AppError::Validation(format!("{trimmed} is not a file")));
    }
    if metadata.len() > MAX_CUSTOM_FILE_BYTES {
        return Err(AppError::Validation(format!(
            "file {trimmed} exceeds the {MAX_CUSTOM_FILE_BYTES} byte limit"
        )));
    }
    Ok(())
}

mod toml_basic {
    use serde::de::DeserializeOwned;

    pub fn from_str<T: DeserializeOwned>(raw: &str) -> Result<T, String> {
        let value: toml::Value = toml::from_str(raw).map_err(|err| err.to_string())?;
        let json_value: serde_json::Value = toml_to_json(value);
        serde_json::from_value(json_value).map_err(|err| err.to_string())
    }

    fn toml_to_json(value: toml::Value) -> serde_json::Value {
        match value {
            toml::Value::String(text) => serde_json::Value::String(text),
            toml::Value::Integer(int) => serde_json::Value::Number(int.into()),
            toml::Value::Float(float) => serde_json::Number::from_f64(float)
                .map(serde_json::Value::Number)
                .unwrap_or(serde_json::Value::Null),
            toml::Value::Boolean(flag) => serde_json::Value::Bool(flag),
            toml::Value::Datetime(dt) => serde_json::Value::String(dt.to_string()),
            toml::Value::Array(values) => {
                serde_json::Value::Array(values.into_iter().map(toml_to_json).collect())
            }
            toml::Value::Table(table) => {
                let mut map = serde_json::Map::new();
                for (key, value) in table {
                    map.insert(key, toml_to_json(value));
                }
                serde_json::Value::Object(map)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::fs;
    use std::path::Path;

    use crate::models::{
        AiApiType, AiImportCandidate, AiImportSource, AiImportSourceKind, AiProfileInput,
    };

    fn write_file(path: &Path, body: &str) {
        fs::create_dir_all(path.parent().expect("parent dir")).expect("create parent");
        fs::write(path, body).expect("write file");
    }

    fn temp_root(name: &str) -> PathBuf {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        std::env::temp_dir().join(format!("eshell-ai-import-{name}-{stamp}"))
    }

    fn build_source(kind: AiImportSourceKind, path: &Path, available: bool) -> AiImportSource {
        AiImportSource {
            id: format!("{kind:?}:{}", path.display()),
            kind,
            label: path.to_string_lossy().to_string(),
            path: path.to_string_lossy().to_string(),
            available,
            note: if available { None } else { Some("missing".to_string()) },
        }
    }

    #[test]
    fn parse_claude_settings_extracts_anthropic_candidate() {
        let body = r#"{
            "env": {
                "ANTHROPIC_AUTH_TOKEN": "sk-test-1",
                "ANTHROPIC_BASE_URL": "https://athenai.example.com/",
                "ANTHROPIC_MODEL": "claude-sonnet-5"
            }
        }"#;

        let path = temp_root("claude").join("settings.json");
        write_file(&path, body);
        let source = build_source(AiImportSourceKind::ClaudeCode, &path, true);

        let (candidates, warnings) = detect_ai_import_candidates(&source).expect("detect");
        assert!(warnings.is_empty(), "warnings: {warnings:?}");
        assert_eq!(candidates.len(), 1);

        let candidate = &candidates[0];
        assert_eq!(candidate.api_type, AiApiType::AnthropicMessages);
        assert_eq!(candidate.api_key, "sk-test-1");
        assert_eq!(candidate.base_url, "https://athenai.example.com");
        assert_eq!(candidate.model, "claude-sonnet-5");
        assert!(candidate.notes.is_empty(), "notes: {:?}", candidate.notes);
    }

    #[test]
    fn parse_claude_settings_reports_missing_key() {
        let body = r#"{
            "env": {
                "ANTHROPIC_BASE_URL": "https://api.anthropic.com"
            }
        }"#;
        let path = temp_root("claude-no-key").join("settings.json");
        write_file(&path, body);
        let source = build_source(AiImportSourceKind::ClaudeCode, &path, true);

        let (candidates, _warnings) = detect_ai_import_candidates(&source).expect("detect");
        assert_eq!(candidates.len(), 1);
        assert!(candidates[0].api_key.is_empty());
        assert!(
            candidates[0].notes.iter().any(|note| note.contains("No API key")),
            "expected missing key note, got {:?}",
            candidates[0].notes
        );
    }

    #[test]
    fn parse_codex_config_reads_default_model_and_env_key() {
        let body = r#"
model = "gpt-5.6-sol"
model_provider = "custom"
wire_api = "responses"
requires_openai_auth = true

[model_providers.custom]
name = "custom"
wire_api = "responses"
requires_openai_auth = true
base_url = "https://athenai.example.com/v1/"

[shell_environment_policy.set]
ANTHROPIC_AUTH_TOKEN = "sk-codex-1"
"#;
        let path = temp_root("codex").join("config.toml");
        write_file(&path, body);
        let source = build_source(AiImportSourceKind::Codex, &path, true);

        let (candidates, warnings) = detect_ai_import_candidates(&source).expect("detect");
        assert!(warnings.is_empty(), "warnings: {warnings:?}");
        assert_eq!(candidates.len(), 2);

        let default_candidate = candidates
            .iter()
            .find(|item| item.name.contains("default"))
            .expect("default candidate");
        assert_eq!(default_candidate.api_type, AiApiType::OpenAiResponses);
        assert_eq!(default_candidate.model, "gpt-5.6-sol");
        assert_eq!(default_candidate.api_key, "sk-codex-1");
        assert_eq!(default_candidate.base_url, "https://athenai.example.com/v1");

        let provider_candidate = candidates
            .iter()
            .find(|item| item.name.contains("custom"))
            .expect("provider candidate");
        assert_eq!(provider_candidate.api_type, AiApiType::OpenAiResponses);
        assert_eq!(provider_candidate.api_key, "sk-codex-1");
        assert_eq!(provider_candidate.base_url, "https://athenai.example.com/v1");
    }

    #[test]
    fn parse_codex_falls_back_to_anthropic_for_athenai_gateway() {
        let body = r#"
model = "claude-sonnet-5"

[model_providers.athenai]
name = "athenai"
base_url = "https://athenai.example.com/"

[shell_environment_policy.set]
ANTHROPIC_AUTH_TOKEN = "sk-athenai-1"
"#;
        let path = temp_root("codex-anthropic").join("config.toml");
        write_file(&path, body);
        let source = build_source(AiImportSourceKind::Codex, &path, true);

        let (candidates, _warnings) = detect_ai_import_candidates(&source).expect("detect");
        assert!(candidates
            .iter()
            .all(|item| item.api_type == AiApiType::AnthropicMessages));
        assert!(candidates
            .iter()
            .all(|item| item.api_key == "sk-athenai-1"));
    }

    #[test]
    fn parse_custom_json_supports_minimal_openai_shape() {
        let body = r#"{
            "apiKey": "sk-custom-1",
            "baseUrl": "https://api.example.com/v1",
            "model": "gpt-4o-mini"
        }"#;
        let path = temp_root("custom").join("openai.json");
        write_file(&path, body);
        let source = build_source(AiImportSourceKind::CustomJson, &path, true);

        let (candidates, _warnings) = detect_ai_import_candidates(&source).expect("detect");
        assert_eq!(candidates.len(), 1);
        let candidate = &candidates[0];
        assert_eq!(candidate.api_type, AiApiType::OpenAiChatCompletions);
        assert_eq!(candidate.api_key, "sk-custom-1");
        assert_eq!(candidate.base_url, "https://api.example.com/v1");
        assert_eq!(candidate.model, "gpt-4o-mini");
    }

    #[test]
    fn detect_returns_error_for_unavailable_source() {
        let source = AiImportSource {
            id: "missing".to_string(),
            kind: AiImportSourceKind::Codex,
            label: "Codex".to_string(),
            path: String::new(),
            available: false,
            note: Some("not found".to_string()),
        };
        let result = detect_ai_import_candidates(&source);
        assert!(result.is_err());
    }

    #[test]
    fn merge_imports_skips_duplicates_and_persists() {
        let storage_root = temp_root("merge-imp");
        let storage = crate::storage::Storage::new(storage_root.clone()).expect("storage");
        storage
            .save_ai_profile(AiProfileInput {
                id: None,
                name: "Existing".to_string(),
                api_type: AiApiType::OpenAiChatCompletions,
                base_url: "https://api.openai.com/v1".to_string(),
                api_key: "sk-existing".to_string(),
                model: "gpt-4o-mini".to_string(),
                system_prompt: String::new(),
                temperature: 0.2,
                max_tokens: 800,
                max_context_tokens: 100_000,
            })
            .expect("seed profile");
        let seeded_count = storage.list_ai_profiles().profiles.len();

        let candidates = vec![
            AiImportCandidate {
                source_id: "s1".to_string(),
                source_kind: AiImportSourceKind::ClaudeCode,
                source_label: "Claude".to_string(),
                source_path: "/tmp/settings.json".to_string(),
                name: "Claude new".to_string(),
                api_type: AiApiType::AnthropicMessages,
                base_url: "https://api.anthropic.com".to_string(),
                api_key: "sk-anthropic".to_string(),
                model: "claude-3-5-sonnet-latest".to_string(),
                temperature: 0.2,
                max_tokens: 800,
                max_context_tokens: 100_000,
                system_prompt: String::new(),
                notes: Vec::new(),
            },
            AiImportCandidate {
                source_id: "s1".to_string(),
                source_kind: AiImportSourceKind::Codex,
                source_label: "Codex".to_string(),
                source_path: "/tmp/config.toml".to_string(),
                name: "Codex duplicate".to_string(),
                api_type: AiApiType::OpenAiChatCompletions,
                base_url: "https://api.openai.com/v1".to_string(),
                api_key: "sk-dup".to_string(),
                model: "gpt-4o-mini".to_string(),
                temperature: 0.2,
                max_tokens: 800,
                max_context_tokens: 100_000,
                system_prompt: String::new(),
                notes: Vec::new(),
            },
            AiImportCandidate {
                source_id: "s1".to_string(),
                source_kind: AiImportSourceKind::Codex,
                source_label: "Codex".to_string(),
                source_path: "/tmp/config.toml".to_string(),
                name: "Codex new".to_string(),
                api_type: AiApiType::OpenAiChatCompletions,
                base_url: "https://api.openai.com/v1".to_string(),
                api_key: "sk-new".to_string(),
                model: "gpt-4.1".to_string(),
                temperature: 0.2,
                max_tokens: 800,
                max_context_tokens: 100_000,
                system_prompt: String::new(),
                notes: Vec::new(),
            },
        ];

        let result = storage.import_ai_profiles(candidates).expect("import");
        assert_eq!(result.imported.len(), 2);
        assert_eq!(result.skipped.len(), 1);
        assert!(result
            .skipped
            .iter()
            .any(|note| note.contains("duplicate")));
        let profiles = storage.list_ai_profiles();
        assert_eq!(profiles.profiles.len(), seeded_count + 2);
        assert!(result
            .imported
            .iter()
            .all(|profile| profiles.profiles.iter().any(|item| item.id == profile.id)));
        let _ = fs::remove_dir_all(storage_root);
    }

    #[test]
    fn read_custom_path_rejects_empty_or_missing() {
        let result = read_custom_path_for_detection("   ");
        assert!(result.is_err());
        let result = read_custom_path_for_detection("/definitely/missing/file.json");
        assert!(result.is_err());
    }

    #[test]
    fn list_sources_dedupes_paths() {
        let custom = vec![
            "/tmp/ai-import-a.json".to_string(),
            "/tmp/ai-import-a.json".to_string(),
            "/tmp/ai-import-b.json".to_string(),
        ];
        let sources = list_ai_import_sources(&custom);
        let custom_count = sources
            .iter()
            .filter(|item| matches!(item.kind, AiImportSourceKind::CustomJson))
            .count();
        assert!(custom_count <= 2);
    }
}
