use serde::Serialize;
use tauri::command;

#[derive(Serialize)]
pub struct PushToken {
    pub token: String,
    pub platform: String,
}

#[command]
pub async fn get_token() -> Result<PushToken, String> {
    // On mobile, the native layer (Kotlin/Swift) registers for push and
    // provides the token via the plugin bridge. This is a placeholder that
    // returns the cached token from the native side.
    Err("Push token not available on this platform".to_string())
}

#[command]
pub async fn on_notification() -> Result<(), String> {
    // Notification handling is done via event listeners on the native side.
    // This command exists as a placeholder for the JS API surface.
    Ok(())
}
