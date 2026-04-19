use crate::error::AppResult;
use crate::ops_agent::domain::types::OpsAgentAttachmentContent;
use crate::ops_agent::infrastructure::logging::append_debug_log;
use crate::state::AppState;

pub fn get_attachment_content(
    state: &AppState,
    attachment_id: &str,
) -> AppResult<OpsAgentAttachmentContent> {
    let content = state
        .ops_agent_attachments
        .get_attachment_content(attachment_id)?;
    append_debug_log(
        state,
        "application.attachments.read",
        None,
        None,
        format!(
            "attachment_id={} content_type={} size_bytes={}",
            content.id, content.content_type, content.size_bytes
        ),
    );
    Ok(content)
}
