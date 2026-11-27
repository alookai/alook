use crate::mobile_share_image::{
    decode_header_filename, stage_validated_png, validate_raw_payload, MobileShareImageError,
    MobileShareImageResult, MobileShareImageState, StagedMobileShareImage,
};
use crate::native_command_guard::guard;
use std::sync::OnceLock;
use std::time::Instant;
use tauri::{ipc::InvokeBody, Manager, WebviewWindow};
use tauri_plugin_mobile_share_image::{CopyRequest, MobileShareImageExt, SaveRequest};

fn monotonic_micros() -> u128 {
    static START: OnceLock<Instant> = OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_micros()
}

fn parse_raw_request(
    request: tauri::ipc::Request<'_>,
) -> Result<(String, Vec<u8>, Option<String>), MobileShareImageError> {
    let attempt_id = request
        .headers()
        .get("x-attempt-id")
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned)
        .ok_or_else(|| MobileShareImageError::new("invalid_png", "Missing attempt identifier"))?;
    let filename = match request.headers().get("x-filename") {
        Some(value) => {
            let raw = value.to_str().map_err(|_| {
                MobileShareImageError::new("invalid_png", "Invalid filename header")
            })?;
            Some(decode_header_filename(raw)?)
        }
        None => None,
    };
    let bytes = match request.body() {
        InvokeBody::Raw(bytes) => bytes.clone(),
        InvokeBody::Json(_) => {
            return Err(MobileShareImageError::new(
                "invalid_png",
                "Image payload must use binary IPC",
            ));
        }
    };
    Ok((attempt_id, bytes, filename))
}

async fn validate_and_stage(
    window: &WebviewWindow,
    attempt_id: String,
    bytes: Vec<u8>,
    filename: Option<String>,
) -> Result<StagedMobileShareImage, MobileShareImageError> {
    let cache_root =
        window.app_handle().path().app_cache_dir().map_err(|_| {
            MobileShareImageError::new("write_failed", "Cache directory unavailable")
        })?;
    tauri::async_runtime::spawn_blocking(move || {
        let validated = validate_raw_payload(attempt_id, bytes, filename)?;
        stage_validated_png(&cache_root, validated)
    })
    .await
    .map_err(|_| MobileShareImageError::new("write_failed", "Image validation task failed"))?
}

#[tauri::command]
pub async fn mobile_share_image_save(
    window: WebviewWindow,
    state: tauri::State<'_, MobileShareImageState>,
    request: tauri::ipc::Request<'_>,
) -> Result<MobileShareImageResult, MobileShareImageError> {
    guard(&window).map_err(|code| MobileShareImageError::new(code, "Caller is not trusted"))?;
    let _lease = state.acquire()?;
    let (attempt_id, bytes, filename) = parse_raw_request(request)?;
    let staged = validate_and_stage(&window, attempt_id, bytes, filename).await?;
    if cfg!(debug_assertions) {
        eprintln!(
            "mobile-share-image app-rust dispatch attempt={} t={}",
            staged.attempt_id,
            monotonic_micros()
        );
    }
    let result = window
        .app_handle()
        .mobile_share_image()
        .save(SaveRequest {
            attempt_id: staged.attempt_id.clone(),
            path: staged.path.to_string_lossy().into_owned(),
            bytes: staged.bytes,
            sha256: staged.sha256.clone(),
            filename: staged.filename.clone(),
        })
        .await
        .map_err(|error| MobileShareImageError::new(&error.code, error.message))?;
    if result.attempt_id != staged.attempt_id
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
    request: tauri::ipc::Request<'_>,
) -> Result<MobileShareImageResult, MobileShareImageError> {
    guard(&window).map_err(|code| MobileShareImageError::new(code, "Caller is not trusted"))?;
    let _lease = state.acquire()?;
    let (attempt_id, bytes, _) = parse_raw_request(request)?;
    let staged = validate_and_stage(&window, attempt_id, bytes, None).await?;
    if cfg!(debug_assertions) {
        eprintln!(
            "mobile-share-image app-rust dispatch attempt={} t={}",
            staged.attempt_id,
            monotonic_micros()
        );
    }
    let result = window
        .app_handle()
        .mobile_share_image()
        .copy(CopyRequest {
            attempt_id: staged.attempt_id.clone(),
            path: staged.path.to_string_lossy().into_owned(),
            bytes: staged.bytes,
            sha256: staged.sha256.clone(),
        })
        .await
        .map_err(|error| MobileShareImageError::new(&error.code, error.message))?;
    if result.attempt_id != staged.attempt_id
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
