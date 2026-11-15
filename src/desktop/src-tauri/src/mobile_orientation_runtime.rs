use crate::native_command_guard::guard;
use std::sync::Mutex;
use tauri::{ipc::Channel, AppHandle, Manager, WebviewWindow};
use tauri_plugin_mobile_orientation::{ListenRequest, MobileOrientationExt};

#[derive(Default)]
pub struct MobileOrientationState(Mutex<u64>);

impl MobileOrientationState {
    fn next(&self) -> Result<u64, String> {
        let mut counter = self.0.lock().map_err(|_| "orientation_unavailable")?;
        *counter = counter
            .checked_add(1)
            .filter(|value| *value <= 9_007_199_254_740_991)
            .ok_or("orientation_unavailable")?;
        Ok(*counter)
    }
}

#[tauri::command]
pub async fn mobile_orientation_listen(
    window: WebviewWindow,
    channel: Channel<()>,
) -> Result<u64, String> {
    guard(&window).map_err(str::to_owned)?;
    let app = window.app_handle();
    let registration_id = app.state::<MobileOrientationState>().next()?;
    app.mobile_orientation()
        .listen(ListenRequest {
            registration_id,
            channel,
        })
        .await
        .map_err(|_| "orientation_unavailable")?;
    Ok(registration_id)
}

#[tauri::command]
pub async fn mobile_orientation_unlisten(
    window: WebviewWindow,
    registration_id: u64,
) -> Result<(), String> {
    guard(&window).map_err(str::to_owned)?;
    window
        .app_handle()
        .mobile_orientation()
        .unlisten(registration_id)
        .await
        .map_err(|_| "orientation_unavailable".to_owned())
}

pub fn retire(app: &AppHandle) {
    let Ok(registration_id) = app.state::<MobileOrientationState>().next() else {
        return;
    };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = app.mobile_orientation().retire(registration_id).await;
    });
}
