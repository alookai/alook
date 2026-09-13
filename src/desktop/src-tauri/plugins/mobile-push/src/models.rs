use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionResponse {
    pub permission_state: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistrationSnapshot {
    pub installation_id: String,
    pub platform: String,
    pub provider_environment: String,
    pub provider_token: Option<String>,
    pub previous_provider_token: Option<String>,
    pub app_version: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Activation {
    pub notification_id: String,
    pub message_id: String,
    pub target_id: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcknowledgeRequest {
    pub provider_token: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListenRequest {
    pub channel: Channel<()>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnlistenRequest {
    pub registration_id: u64,
}
