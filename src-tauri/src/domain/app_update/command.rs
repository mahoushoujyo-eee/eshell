//! Tauri command surface for the app-update domain.

use crate::domain::app_update::model::ReleaseCheck;
use crate::domain::app_update::service;

/// The version this build reports, without a leading `v`.
#[tauri::command]
pub fn app_version() -> String {
    service::current_version()
}

/// Looks up the newest published release and compares it to this build.
#[tauri::command]
pub async fn check_app_update() -> Result<ReleaseCheck, String> {
    service::check_app_update().await
}
