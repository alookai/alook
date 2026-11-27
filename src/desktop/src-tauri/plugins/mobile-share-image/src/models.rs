use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveRequest {
    pub attempt_id: String,
    pub path: String,
    pub bytes: u64,
    pub sha256: String,
    pub filename: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyRequest {
    pub attempt_id: String,
    pub path: String,
    pub bytes: u64,
    pub sha256: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageResult {
    pub attempt_id: String,
    pub status: String,
    pub destination: String,
}
