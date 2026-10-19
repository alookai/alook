use crate::{error::Result, models::*, TouchSetup};
use tauri::Runtime;

impl<R: Runtime> TouchSetup<R> {
    pub async fn connect(&self, request: Connection) -> Result<()> {
        self.0
            .run_mobile_plugin_async("connect", request)
            .await
            .map_err(|_| "setup_connection_failed")
    }
    pub async fn scan(&self, attempt_id: String) -> Result<Vec<Network>> {
        self.0
            .run_mobile_plugin_async::<NetworksResponse>("scanNetworks", Attempt { attempt_id })
            .await
            .map(|value| value.networks)
            .map_err(|_| "setup_scan_failed")
    }
    pub async fn provision(&self, request: Provision) -> Result<()> {
        self.0
            .run_mobile_plugin_async("provision", request)
            .await
            .map_err(|_| "setup_wifi_failed")
    }
    pub async fn exchange(&self, request: Exchange) -> Result<String> {
        self.0
            .run_mobile_plugin_async::<ExchangeResponse>("exchange", request)
            .await
            .map(|value| value.response)
            .map_err(|_| "setup_exchange_failed")
    }
    pub async fn cancel(&self, attempt_id: String) -> Result<()> {
        self.0
            .run_mobile_plugin_async("cancel", Attempt { attempt_id })
            .await
            .map_err(|_| "setup_cancel_failed")
    }
}
