use crate::{
    file_save::{Ack, Begin, Chunk, Commit, Receipt, Transfer},
    native_command_guard,
};
use std::{
    collections::VecDeque,
    fs,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use tauri::{AppHandle, Manager, State, WebviewWindow};

#[derive(Default)]
pub struct FileSaveState {
    session: Mutex<Session>,
    ready: AtomicBool,
}
#[derive(Default)]
struct Session {
    transfer: Option<Transfer>,
    recent_attempts: VecDeque<String>,
    exporting: Option<(String, Arc<AtomicBool>, Arc<Mutex<()>>)>,
}
fn root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_cache_dir()
        .map_err(|_| "Save storage unavailable")?
        .join("user-file-save"))
}
pub fn setup(app: &AppHandle) -> Result<(), String> {
    let path = root(app)?;
    #[cfg(desktop)]
    repair_desktop(&path)?;
    if path.exists() {
        fs::remove_dir_all(&path).map_err(|_| "Save cleanup failed")?;
    }
    fs::create_dir_all(path).map_err(|_| "Save storage unavailable")?;
    app.state::<FileSaveState>()
        .ready
        .store(true, Ordering::Release);
    Ok(())
}
pub fn retire(app: &AppHandle) {
    if let Ok(mut state) = app.state::<FileSaveState>().session.lock() {
        state.transfer.take();
        if let Some((id, cancelled, publish_guard)) = &state.exporting {
            let _publication = publish_guard.lock().ok();
            cancelled.store(true, Ordering::Release);
            #[cfg(mobile)]
            {
                use tauri_plugin_file_save::FileSaveExt;
                let app = app.clone();
                let id = id.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = app.file_save().cancel(id).await;
                });
            }
            #[cfg(desktop)]
            let _ = id;
        }
    }
}
#[tauri::command]
pub fn file_save_begin(
    window: WebviewWindow,
    state: State<'_, FileSaveState>,
    payload: Begin,
) -> Result<Ack, String> {
    native_command_guard::guard(&window)?;
    let mut state = state.session.lock().map_err(|_| "Save state unavailable")?;
    if state.transfer.is_some() || state.exporting.is_some() {
        return Err("Another file is being saved".into());
    }
    if !window
        .app_handle()
        .state::<FileSaveState>()
        .ready
        .load(Ordering::Acquire)
    {
        setup(window.app_handle())?;
    }
    #[cfg(desktop)]
    repair_desktop(&root(window.app_handle())?)?;
    if state.recent_attempts.contains(&payload.attempt_id) {
        return Err("Save attempt already used".into());
    }
    let transfer = Transfer::begin(&root(window.app_handle())?, payload)?;
    state
        .recent_attempts
        .push_back(transfer.metadata.attempt_id.clone());
    if state.recent_attempts.len() > 256 {
        state.recent_attempts.pop_front();
    }
    let ack = transfer.ack();
    state.transfer = Some(transfer);
    Ok(ack)
}
#[tauri::command]
pub fn file_save_write_chunk(
    window: WebviewWindow,
    state: State<'_, FileSaveState>,
    payload: Chunk,
) -> Result<Ack, String> {
    native_command_guard::guard(&window)?;
    let mut state = state.session.lock().map_err(|_| "Save state unavailable")?;
    let transfer = state.transfer.as_mut().ok_or("No active save")?;
    if transfer.metadata.attempt_id != payload.attempt_id {
        return Err("Unknown save attempt".into());
    }
    let result = transfer.write(payload);
    if result.is_err() {
        state.transfer.take();
    }
    result
}
#[tauri::command]
pub async fn file_save_cancel(
    window: WebviewWindow,
    app: AppHandle,
    attempt_id: String,
) -> Result<(), String> {
    native_command_guard::guard(&window)?;
    let exporting = {
        let state = app.state::<FileSaveState>();
        let mut state = state.session.lock().map_err(|_| "Save state unavailable")?;
        if state
            .transfer
            .as_ref()
            .is_some_and(|t| t.metadata.attempt_id == attempt_id)
        {
            state.transfer.take();
        }
        if let Some((id, cancelled, publish_guard)) = &state.exporting {
            if id == &attempt_id {
                let _publication = publish_guard.lock().ok();
                cancelled.store(true, Ordering::Release);
                true
            } else {
                false
            }
        } else {
            false
        }
    };
    #[cfg(mobile)]
    if exporting {
        use tauri_plugin_file_save::FileSaveExt;
        app.file_save()
            .cancel(attempt_id)
            .await
            .map_err(|_| "Save cancellation failed")?;
    }
    #[cfg(desktop)]
    let _ = exporting;
    Ok(())
}
#[tauri::command]
pub async fn file_save_commit(
    window: WebviewWindow,
    app: AppHandle,
    payload: Commit,
) -> Result<Receipt, String> {
    native_command_guard::guard(&window)?;
    let mut transfer = {
        let state = app.state::<FileSaveState>();
        let mut state = state.session.lock().map_err(|_| "Save state unavailable")?;
        if state
            .transfer
            .as_ref()
            .is_none_or(|t| t.metadata.attempt_id != payload.attempt_id)
        {
            return Err("Unknown save attempt".into());
        }
        let transfer = state.transfer.take().ok_or("No active save")?;
        state.exporting = Some((
            transfer.metadata.attempt_id.clone(),
            transfer.cancelled.clone(),
            transfer.publish_guard.clone(),
        ));
        transfer
    };
    let result = match transfer.seal(payload) {
        Err(error) => Err(error),
        Ok(()) => export(&app, &transfer)
            .await
            .map(|destination| transfer.receipt(destination)),
    };
    if let Ok(mut state) = app.state::<FileSaveState>().session.lock() {
        state.exporting = None;
    }
    result
}
#[cfg(mobile)]
async fn export(app: &AppHandle, transfer: &Transfer) -> Result<Option<String>, String> {
    use tauri_plugin_file_save::{ExportRequest, FileSaveExt};
    if transfer.cancelled.load(Ordering::Acquire) {
        return Ok(None);
    }
    let result = app
        .file_save()
        .export(ExportRequest {
            attempt_id: transfer.metadata.attempt_id.clone(),
            path: transfer.path.to_string_lossy().into_owned(),
            name: transfer.metadata.name.clone(),
            mime: transfer.metadata.mime.clone(),
            bytes: transfer.bytes,
            sha256: transfer.receipt(None).sha256,
        })
        .await
        .map_err(|_| "File export failed")?;
    if result.attempt_id != transfer.metadata.attempt_id {
        return Err("Invalid export receipt".into());
    }
    match result.status.as_str() {
        "saved" if ["downloads", "files", "document"].contains(&result.destination.as_str()) => {
            Ok(Some(result.destination))
        }
        "cancelled" => Ok(None),
        _ => Err("File export failed".into()),
    }
}
#[cfg(desktop)]
async fn export(app: &AppHandle, transfer: &Transfer) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let journal = root(app)?;
    let app = app.clone();
    let name = transfer.metadata.name.clone();
    let path = tauri::async_runtime::spawn_blocking(move || {
        app.dialog().file().set_file_name(name).blocking_save_file()
    })
    .await
    .map_err(|_| "Save dialog failed")?;
    if transfer.cancelled.load(Ordering::Acquire) {
        return Ok(None);
    }
    let Some(path) = path else {
        return Ok(None);
    };
    let path = path.into_path().map_err(|_| "Invalid save destination")?;
    let source = transfer.path.clone();
    let id = transfer.metadata.attempt_id.clone();
    let cancelled = transfer.cancelled.clone();
    let publish_guard = transfer.publish_guard.clone();
    tauri::async_runtime::spawn_blocking(move || {
        copy_desktop(&source, &path, &id, &cancelled, &publish_guard, &journal)
    })
    .await
    .map_err(|_| "File export failed")?
}
#[cfg(desktop)]
fn copy_desktop(
    source: &std::path::Path,
    target: &std::path::Path,
    id: &str,
    cancelled: &AtomicBool,
    publish_guard: &Mutex<()>,
    journal: &std::path::Path,
) -> Result<Option<String>, String> {
    use std::io::{Read, Write};
    let parent = target.parent().ok_or("Invalid save destination")?;
    let partial = parent.join(format!(".alook-{id}.partial"));
    crate::file_save_journal::repair(journal, &crate::file_save_journal::Disk)?;
    crate::file_save_journal::prepare(journal, &partial, &crate::file_save_journal::Disk)?;
    let mut created = false;
    let result = (|| {
        let mut input = fs::File::open(source).map_err(|_| "File read failed")?;
        let mut options = fs::OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut output = options.open(&partial).map_err(|_| "File write failed")?;
        created = true;
        let mut buffer = [0u8; 65_536];
        loop {
            if cancelled.load(Ordering::Acquire) {
                return Ok(None);
            }
            let n = input.read(&mut buffer).map_err(|_| "File read failed")?;
            if n == 0 {
                break;
            }
            output
                .write_all(&buffer[..n])
                .map_err(|_| "File write failed")?;
        }
        output.sync_all().map_err(|_| "File write failed")?;
        drop(output);
        let _publication = publish_guard.lock().map_err(|_| "Save state unavailable")?;
        if cancelled.load(Ordering::Acquire) {
            return Ok(None);
        }
        fs::rename(&partial, target).map_err(|_| "File publish failed")?;
        Ok(Some("desktop".into()))
    })();
    let _ = crate::file_save_journal::finish(
        journal,
        &partial,
        created,
        &crate::file_save_journal::Disk,
    );
    result
}
#[cfg(desktop)]
fn repair_desktop(root: &std::path::Path) -> Result<(), String> {
    crate::file_save_journal::repair(root, &crate::file_save_journal::Disk)
}
#[cfg(all(test, desktop))]
mod tests {
    use super::*;
    fn fixture() -> PathBuf {
        let mut bytes = [0u8; 16];
        getrandom::fill(&mut bytes).unwrap();
        let root = std::env::temp_dir().join(format!("alook-export-test-{:x?}", bytes));
        fs::create_dir_all(&root).unwrap();
        root
    }
    const ID: &str = "00000000-0000-4000-8000-000000000001";
    #[test]
    fn atomic_export_replaces_only_after_complete_and_cleans_cancel() {
        let root = fixture();
        let source = root.join("source");
        let target = root.join("target");
        fs::write(&source, vec![42; 131_073]).unwrap();
        fs::write(&target, b"old").unwrap();
        assert_eq!(
            copy_desktop(
                &source,
                &target,
                ID,
                &AtomicBool::new(true),
                &Mutex::new(()),
                &root
            )
            .unwrap(),
            None
        );
        assert_eq!(fs::read(&target).unwrap(), b"old");
        assert_eq!(
            copy_desktop(
                &source,
                &target,
                ID,
                &AtomicBool::new(false),
                &Mutex::new(()),
                &root
            )
            .unwrap(),
            Some("desktop".into())
        );
        assert_eq!(fs::read(&target).unwrap(), fs::read(source).unwrap());
        assert!(!root.join("desktop-export.json").exists());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn startup_reclaims_partial_and_keeps_existing_destination() {
        let root = fixture();
        let partial = root.join(format!(".alook-{ID}.partial"));
        let target = root.join("target");
        fs::write(&partial, b"incomplete").unwrap();
        fs::write(&target, b"old").unwrap();
        fs::write(
            root.join("desktop-export.json"),
            serde_json::to_vec(&partial).unwrap(),
        )
        .unwrap();
        repair_desktop(&root).unwrap();
        assert!(!partial.exists());
        assert_eq!(fs::read(target).unwrap(), b"old");
        fs::remove_dir_all(root).unwrap();
    }
}
