use serde::{Deserialize, Serialize};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    pub attempt_id: String,
    pub name: String,
    pub pop: String,
    pub service_uuid: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Attempt {
    pub attempt_id: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Provision {
    pub attempt_id: String,
    pub ssid: String,
    pub password: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Exchange {
    pub attempt_id: String,
    pub action: String,
    pub user_code: Option<String>,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Network {
    pub ssid: String,
    pub rssi: i32,
    pub secured: bool,
}

#[derive(Deserialize)]
pub struct NetworksResponse {
    pub networks: Vec<Network>,
}
#[derive(Deserialize)]
pub struct ExchangeResponse {
    pub response: String,
}
