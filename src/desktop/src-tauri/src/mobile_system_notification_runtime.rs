use crate::mobile_system_notification::{
    validate_activation, validate_permission, validate_provider_token, validate_snapshot,
    Activation, MobileSystemNotificationError, PermissionResponse, RegistrationSnapshot,
};
use crate::native_command_guard::guard;
use tauri::{ipc::Channel, Manager, WebviewWindow};
use tauri_plugin_mobile_push::{Activation as NativeActivation, MobilePushExt};

impl From<tauri_plugin_mobile_push::Error> for MobileSystemNotificationError {
    fn from(error: tauri_plugin_mobile_push::Error) -> Self {
        Self {
            code: error.code,
            message: error.message,
        }
    }
}

#[tauri::command]
pub async fn mobile_system_notification_check_permission(
    window: WebviewWindow,
) -> Result<PermissionResponse, MobileSystemNotificationError> {
    guard(&window)
        .map_err(|code| MobileSystemNotificationError::new(code, "Caller is not trusted"))?;
    let native = window
        .app_handle()
        .mobile_push()
        .check_permissions()
        .await?;
    validate_permission(PermissionResponse {
        permission_state: native.permission_state,
    })
}

#[tauri::command]
pub async fn mobile_system_notification_request_permission(
    window: WebviewWindow,
) -> Result<PermissionResponse, MobileSystemNotificationError> {
    guard(&window)
        .map_err(|code| MobileSystemNotificationError::new(code, "Caller is not trusted"))?;
    let native = window
        .app_handle()
        .mobile_push()
        .request_permissions()
        .await?;
    validate_permission(PermissionResponse {
        permission_state: native.permission_state,
    })
}

#[tauri::command]
pub async fn mobile_system_notification_snapshot(
    window: WebviewWindow,
) -> Result<RegistrationSnapshot, MobileSystemNotificationError> {
    guard(&window)
        .map_err(|code| MobileSystemNotificationError::new(code, "Caller is not trusted"))?;
    let native = window.app_handle().mobile_push().snapshot().await?;
    validate_snapshot(RegistrationSnapshot {
        installation_id: native.installation_id,
        platform: native.platform,
        provider_environment: native.provider_environment,
        provider_token: native.provider_token,
        previous_provider_token: native.previous_provider_token,
        app_version: native.app_version,
    })
}

#[tauri::command]
pub async fn mobile_system_notification_acknowledge_registration(
    window: WebviewWindow,
    provider_token: String,
) -> Result<(), MobileSystemNotificationError> {
    guard(&window)
        .map_err(|code| MobileSystemNotificationError::new(code, "Caller is not trusted"))?;
    validate_provider_token(&provider_token)?;
    window
        .app_handle()
        .mobile_push()
        .acknowledge_registration(provider_token)
        .await?;
    Ok(())
}

#[tauri::command]
pub async fn mobile_system_notification_take_activation(
    window: WebviewWindow,
) -> Result<Option<Activation>, MobileSystemNotificationError> {
    guard(&window)
        .map_err(|code| MobileSystemNotificationError::new(code, "Caller is not trusted"))?;
    let native = window.app_handle().mobile_push().take_activation().await?;
    validate_activation(native.map(|value: NativeActivation| Activation {
        notification_id: value.notification_id,
        message_id: value.message_id,
        target_id: value.target_id,
    }))
}

#[tauri::command]
pub async fn mobile_system_notification_listen(
    window: WebviewWindow,
    channel: Channel<()>,
) -> Result<u64, MobileSystemNotificationError> {
    guard(&window)
        .map_err(|code| MobileSystemNotificationError::new(code, "Caller is not trusted"))?;
    Ok(window.app_handle().mobile_push().listen(channel).await?)
}

#[tauri::command]
pub async fn mobile_system_notification_unlisten(
    window: WebviewWindow,
    registration_id: u64,
) -> Result<(), MobileSystemNotificationError> {
    guard(&window)
        .map_err(|code| MobileSystemNotificationError::new(code, "Caller is not trusted"))?;
    window
        .app_handle()
        .mobile_push()
        .unlisten(registration_id)
        .await?;
    Ok(())
}
