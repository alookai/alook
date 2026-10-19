use crate::{
    native_command_guard,
    touch_setup::{self, TouchSetupState},
};
use tauri::{AppHandle, Manager, State, WebviewWindow};
use tauri_plugin_touch_setup::{
    models::{Connection, Exchange, Network, Provision},
    TouchSetupExt,
};

pub fn retire(app: &AppHandle) {
    if let Some(id) = app.state::<TouchSetupState>().retire() {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let _ = app.touch_setup().cancel(id).await;
        });
    }
}
#[tauri::command]
pub async fn touch_setup_connect(
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, TouchSetupState>,
    attempt_id: String,
    name: String,
    pop: String,
    service_uuid: String,
) -> Result<(), String> {
    native_command_guard::guard(&window)?;
    touch_setup::validate_connection(&name, &pop, &service_uuid)?;
    let lease = state.begin(&attempt_id)?;
    app.touch_setup()
        .connect(Connection {
            attempt_id,
            name,
            pop,
            service_uuid,
        })
        .await?;
    native_command_guard::guard(&window)?;
    lease.connected()?;
    Ok(())
}
#[tauri::command]
pub async fn touch_setup_scan(
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, TouchSetupState>,
    attempt_id: String,
) -> Result<Vec<Network>, String> {
    native_command_guard::guard(&window)?;
    let lease = state.acquire(&attempt_id)?;
    let mut networks = app.touch_setup().scan(attempt_id).await?;
    lease.check()?;
    native_command_guard::guard(&window)?;
    networks.retain(|item| {
        touch_setup::validate_network(&item.ssid, "").is_ok() && (-127..=0).contains(&item.rssi)
    });
    networks.sort_by_key(|item| -item.rssi);
    let mut seen = std::collections::HashSet::new();
    networks.retain(|item| seen.insert(item.ssid.clone()));
    networks.truncate(100);
    Ok(networks)
}
#[tauri::command]
pub async fn touch_setup_provision(
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, TouchSetupState>,
    attempt_id: String,
    ssid: String,
    password: String,
) -> Result<(), String> {
    native_command_guard::guard(&window)?;
    touch_setup::validate_network(&ssid, &password)?;
    let lease = state.acquire(&attempt_id)?;
    app.touch_setup()
        .provision(Provision {
            attempt_id,
            ssid,
            password,
        })
        .await?;
    lease.check()?;
    native_command_guard::guard(&window)?;
    Ok(())
}
#[tauri::command]
pub async fn touch_setup_exchange(
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, TouchSetupState>,
    attempt_id: String,
    action: String,
    user_code: Option<String>,
) -> Result<String, String> {
    native_command_guard::guard(&window)?;
    touch_setup::validate_exchange(&action, user_code.as_deref())?;
    let lease = state.acquire(&attempt_id)?;
    let response = app
        .touch_setup()
        .exchange(Exchange {
            attempt_id,
            action: action.clone(),
            user_code: user_code.clone(),
        })
        .await?;
    lease.check()?;
    native_command_guard::guard(&window)?;
    touch_setup::validate_grant(
        &response,
        if action == "ack" {
            user_code.as_deref()
        } else {
            None
        },
    )?;
    Ok(response)
}
#[tauri::command]
pub async fn touch_setup_cancel(
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, TouchSetupState>,
    attempt_id: String,
) -> Result<(), String> {
    native_command_guard::guard(&window)?;
    state.cancel(&attempt_id)?;
    app.touch_setup().cancel(attempt_id).await?;
    Ok(())
}
