//! Project registry rows: one local working directory ACP sessions run in.

use serde::{Deserialize, Serialize};

/// One local project root an ACP session can run in.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpProject {
    pub id: String,
    pub name: String,
    pub path: String,
    #[serde(default)]
    pub created_at: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpProjectCreateInput {
    pub path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpProjectIdInput {
    pub id: String,
}
