use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::models::now_rfc3339;
use crate::ops_agent::domain::types::{OpsAgentAttachmentContent, OpsAgentImageAttachmentInput};
use crate::ops_agent::infrastructure::logging::{
    append_debug_log_at_path, resolve_ops_agent_log_path,
};

const ATTACHMENTS_DIR: &str = "ops_agent_attachments";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredAttachmentMeta {
    id: String,
    file_name: Option<String>,
    content_type: String,
    size_bytes: usize,
    created_at: String,
}

pub struct OpsAgentAttachmentStore {
    log_path: PathBuf,
    attachments_dir: PathBuf,
}

impl OpsAgentAttachmentStore {
    pub fn new(root: PathBuf) -> AppResult<Self> {
        let log_path = resolve_ops_agent_log_path(&root);
        let attachments_dir = root.join(ATTACHMENTS_DIR);
        fs::create_dir_all(&attachments_dir)?;
        append_debug_log_at_path(
            &log_path,
            "infrastructure.attachments.initialized",
            None,
            None,
            format!("attachments_dir={}", attachments_dir.display()),
        );

        Ok(Self {
            log_path,
            attachments_dir,
        })
    }

    pub fn save_image_uploads(
        &self,
        uploads: &[OpsAgentImageAttachmentInput],
    ) -> AppResult<Vec<String>> {
        let mut attachment_ids = Vec::with_capacity(uploads.len());

        for upload in uploads {
            match self.save_one_image_upload(upload) {
                Ok(attachment_id) => attachment_ids.push(attachment_id),
                Err(error) => {
                    let _ = self.delete_attachments(&attachment_ids);
                    return Err(error);
                }
            }
        }

        Ok(attachment_ids)
    }

    pub fn get_attachment_content(
        &self,
        attachment_id: &str,
    ) -> AppResult<OpsAgentAttachmentContent> {
        let normalized_id = normalize_attachment_id(attachment_id)?;
        let meta = self.read_meta(normalized_id.as_str())?;
        let bytes_path = self.bytes_path(normalized_id.as_str());
        let bytes = fs::read(&bytes_path).map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                AppError::NotFound(format!("ops agent attachment bytes {}", normalized_id))
            } else {
                AppError::Io(error)
            }
        })?;

        append_debug_log_at_path(
            &self.log_path,
            "infrastructure.attachments.loaded",
            None,
            None,
            format!(
                "attachment_id={} content_type={} size_bytes={}",
                normalized_id, meta.content_type, meta.size_bytes
            ),
        );

        Ok(OpsAgentAttachmentContent {
            id: meta.id,
            file_name: meta.file_name,
            content_type: meta.content_type,
            content_base64: BASE64_STANDARD.encode(bytes),
            size_bytes: meta.size_bytes,
            created_at: meta.created_at,
        })
    }

    pub fn delete_attachments(&self, attachment_ids: &[String]) -> AppResult<()> {
        let unique_ids = unique_attachment_ids(attachment_ids);
        let mut deleted = 0usize;

        for attachment_id in &unique_ids {
            let removed_any = remove_file_if_exists(&self.meta_path(attachment_id.as_str()))?
                | remove_file_if_exists(&self.bytes_path(attachment_id.as_str()))?;
            if removed_any {
                deleted += 1;
            }
        }

        append_debug_log_at_path(
            &self.log_path,
            "infrastructure.attachments.deleted",
            None,
            None,
            format!("requested={} deleted={}", unique_ids.len(), deleted),
        );
        Ok(())
    }

    fn read_meta(&self, attachment_id: &str) -> AppResult<StoredAttachmentMeta> {
        let meta_path = self.meta_path(attachment_id);
        let raw = fs::read_to_string(&meta_path).map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                AppError::NotFound(format!("ops agent attachment metadata {}", attachment_id))
            } else {
                AppError::Io(error)
            }
        })?;
        Ok(serde_json::from_str(&raw)?)
    }

    fn meta_path(&self, attachment_id: &str) -> PathBuf {
        self.attachments_dir.join(format!("{attachment_id}.json"))
    }

    fn bytes_path(&self, attachment_id: &str) -> PathBuf {
        self.attachments_dir.join(format!("{attachment_id}.bin"))
    }

    fn save_one_image_upload(&self, upload: &OpsAgentImageAttachmentInput) -> AppResult<String> {
        let content_type = normalize_image_content_type(upload.content_type.as_str())?;
        let bytes = BASE64_STANDARD.decode(upload.content_base64.as_bytes())?;
        if bytes.is_empty() {
            return Err(AppError::Validation(
                "image attachment payload cannot be empty".to_string(),
            ));
        }

        let id = Uuid::new_v4().to_string();
        let meta = StoredAttachmentMeta {
            id: id.clone(),
            file_name: sanitize_file_name(upload.file_name.as_deref()),
            content_type,
            size_bytes: bytes.len(),
            created_at: now_rfc3339(),
        };
        let bytes_path = self.bytes_path(id.as_str());
        let meta_path = self.meta_path(id.as_str());

        fs::write(&bytes_path, &bytes)?;
        if let Err(error) = write_json_pretty(&meta_path, &meta) {
            let _ = fs::remove_file(&bytes_path);
            return Err(error);
        }

        append_debug_log_at_path(
            &self.log_path,
            "infrastructure.attachments.saved",
            None,
            None,
            format!(
                "attachment_id={} file_name={} content_type={} size_bytes={}",
                meta.id,
                meta.file_name.as_deref().unwrap_or("-"),
                meta.content_type,
                meta.size_bytes
            ),
        );

        Ok(id)
    }
}

fn unique_attachment_ids(attachment_ids: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut result = Vec::new();

    for attachment_id in attachment_ids {
        let normalized = attachment_id.trim();
        if normalized.is_empty() || !seen.insert(normalized.to_string()) {
            continue;
        }
        result.push(normalized.to_string());
    }

    result
}

fn normalize_image_content_type(value: &str) -> AppResult<String> {
    let content_type = value.trim().to_ascii_lowercase();
    if content_type.is_empty() {
        return Err(AppError::Validation(
            "image attachment contentType cannot be empty".to_string(),
        ));
    }
    if !content_type.starts_with("image/") {
        return Err(AppError::Validation(format!(
            "unsupported image attachment contentType: {content_type}"
        )));
    }
    Ok(content_type)
}

fn sanitize_file_name(value: Option<&str>) -> Option<String> {
    let candidate = value?.trim();
    if candidate.is_empty() {
        return None;
    }

    Path::new(candidate)
        .file_name()
        .map(|item| item.to_string_lossy().trim().to_string())
        .filter(|item| !item.is_empty())
}

fn normalize_attachment_id(value: &str) -> AppResult<String> {
    let normalized = value.trim().to_string();
    if normalized.is_empty() {
        return Err(AppError::Validation(
            "attachmentId cannot be empty".to_string(),
        ));
    }
    Ok(normalized)
}

fn write_json_pretty<T: Serialize>(path: &Path, value: &T) -> AppResult<()> {
    let payload = serde_json::to_string_pretty(value)?;
    fs::write(path, payload)?;
    Ok(())
}

fn remove_file_if_exists(path: &Path) -> AppResult<bool> {
    match fs::remove_file(path) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(AppError::Io(error)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_root() -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        std::env::temp_dir().join(format!("ops-agent-attachment-store-{suffix}"))
    }

    #[test]
    fn stores_and_reads_attachment_content() {
        let root = temp_root();
        let store = OpsAgentAttachmentStore::new(root.clone()).expect("create store");

        let ids = store
            .save_image_uploads(&[OpsAgentImageAttachmentInput {
                file_name: Some("diagram.png".to_string()),
                content_type: "image/png".to_string(),
                content_base64: BASE64_STANDARD.encode("png-bytes"),
            }])
            .expect("save");
        assert_eq!(ids.len(), 1);

        let content = store.get_attachment_content(ids[0].as_str()).expect("load");
        assert_eq!(content.file_name.as_deref(), Some("diagram.png"));
        assert_eq!(content.content_type, "image/png");
        assert_eq!(
            BASE64_STANDARD
                .decode(content.content_base64)
                .expect("decode"),
            b"png-bytes"
        );

        let _ = fs::remove_dir_all(root);
    }
}
