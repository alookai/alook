use serde::Serialize;
use tauri::ipc::Channel;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListenRequest {
    pub registration_id: u64,
    pub channel: Channel<()>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StopRequest {
    pub registration_id: u64,
}
