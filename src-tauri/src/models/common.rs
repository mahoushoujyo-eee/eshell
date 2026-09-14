//! Helpers shared by every model module.

use chrono::Utc;

/// Returns current UTC timestamp in RFC3339 format for storage and API responses.
pub fn now_rfc3339() -> String {
    Utc::now().to_rfc3339()
}
