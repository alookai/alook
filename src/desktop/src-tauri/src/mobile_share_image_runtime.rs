use crate::mobile_share_image::{
    validate_payload, MobileShareImageError, MobileShareImagePayload, MobileShareImageResult,
    MobileShareImageState,
};
use crate::native_command_guard::guard;
use std::sync::OnceLock;
use std::time::Instant;
use tauri::{Manager, WebviewWindow};
use tauri_plugin_mobile_share_image::{CopyRequest, MobileShareImageExt, SaveRequest};

fn monotonic_micros() -> u128 {
    static START: OnceLock<Instant> = OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_micros()
}

#[tauri::command]
pub async fn mobile_share_image_save(
    window: WebviewWindow,
    state: tauri::State<'_, MobileShareImageState>,
    payload: MobileShareImagePayload,
) -> Result<MobileShareImageResult, MobileShareImageError> {
    guard(&window).map_err(|code| MobileShareImageError::new(code, "Caller is not trusted"))?;
    let _lease = state.acquire()?;
    let payload = validate_payload(payload)?;
    if cfg!(debug_assertions) {
        eprintln!(
            "mobile-share-image app-rust dispatch attempt={} t={}",
            payload.attempt_id,
            monotonic_micros()
        );
    }
    let result = window
        .app_handle()
        .mobile_share_image()
        .save(SaveRequest {
            attempt_id: payload.attempt_id.clone(),
            png_base64: payload.png_base64,
            filename: payload.filename,
        })
        .await
        .map_err(|error| MobileShareImageError::new(&error.code, error.message))?;
    if result.attempt_id != payload.attempt_id
        || result.status != "saved"
        || !matches!(
            result.destination.as_str(),
            "pictures" | "document" | "photos"
        )
    {
        return Err(MobileShareImageError::new(
            "write_failed",
            "Native image result did not match the request",
        ));
    }
    if cfg!(debug_assertions) {
        eprintln!(
            "mobile-share-image app-rust settle attempt={} t={}",
            result.attempt_id,
            monotonic_micros()
        );
    }
    Ok(MobileShareImageResult {
        attempt_id: result.attempt_id,
        status: result.status,
        destination: result.destination,
    })
}

#[tauri::command]
pub async fn mobile_share_image_copy(
    window: WebviewWindow,
    state: tauri::State<'_, MobileShareImageState>,
    payload: MobileShareImagePayload,
) -> Result<MobileShareImageResult, MobileShareImageError> {
    guard(&window).map_err(|code| MobileShareImageError::new(code, "Caller is not trusted"))?;
    let _lease = state.acquire()?;
    let payload = validate_payload(payload)?;
    if cfg!(debug_assertions) {
        eprintln!(
            "mobile-share-image app-rust dispatch attempt={} t={}",
            payload.attempt_id,
            monotonic_micros()
        );
    }
    let result = window
        .app_handle()
        .mobile_share_image()
        .copy(CopyRequest {
            attempt_id: payload.attempt_id.clone(),
            png_base64: payload.png_base64,
        })
        .await
        .map_err(|error| MobileShareImageError::new(&error.code, error.message))?;
    if result.attempt_id != payload.attempt_id
        || result.status != "copied"
        || result.destination != "clipboard"
    {
        return Err(MobileShareImageError::new(
            "write_failed",
            "Native image result did not match the request",
        ));
    }
    if cfg!(debug_assertions) {
        eprintln!(
            "mobile-share-image app-rust settle attempt={} t={}",
            result.attempt_id,
            monotonic_micros()
        );
    }
    Ok(MobileShareImageResult {
        attempt_id: result.attempt_id,
        status: result.status,
        destination: result.destination,
    })
}
