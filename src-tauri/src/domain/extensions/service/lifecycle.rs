//! Plugin lifecycle: active-guards, busy leases and deactivation fan-out.

use crate::common::error::AppResult;
use crate::state::AppState;

use super::registry::Lease;

/// A lease bound to one plugin call.
///
/// Returned by [`require_plugin_active`]; callers hold it across awaited
/// work, which is what rejects a concurrent disable.
pub struct PluginLease {
    _inner: Lease,
}

/// Fails unless the extension is active, then leases it busy.
///
/// A single atomic step: the enabled check and the busy increment share the
/// registry's one critical section with the flag update, so a concurrent
/// disable either commits entirely before this call (observed here as a
/// refusal) or entirely after it (rejected there as busy). There is no
/// instant at which both succeed — no separate `is_enabled` pre-check that a
/// disable could slip past.
pub fn require_plugin_active(state: &AppState, extension_id: &str) -> AppResult<PluginLease> {
    let lease = state.extensions().lease(extension_id)?;
    Ok(PluginLease { _inner: lease })
}

/// Applies an activation change to plugin state.
///
/// Called by the `set_extension_enabled` Tauri command after the registry
/// accepted the change. A disable clears the plugin's own bookkeeping; user
/// SSH connections are never closed here. Enabling is a no-op beyond the
/// registry flag: state starts empty either way.
pub fn apply_activation(state: &AppState, extension_id: &str, enabled: bool) {
    if enabled {
        return;
    }
    match extension_id {
        crate::domain::sftp::service::EXTENSION_ID => crate::domain::sftp::service::deactivate(state),
        crate::domain::monitor::service::EXTENSION_ID => crate::domain::monitor::service::deactivate(state),
        _ => {}
    }
}
