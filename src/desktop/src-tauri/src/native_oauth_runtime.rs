use crate::current_listener::CurrentListener;
use crate::native_command_guard::guard;
use crate::native_oauth::{Exchange, Proof, Record, Registration, Snapshot};
use serde::Serialize;
use std::sync::{Arc, Mutex};
use tauri::{ipc::Channel, AppHandle, Manager, WebviewWindow};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_store::{Store, StoreExt};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NativeOauthSignal {
    CandidateReady,
    WindowResumed,
}

pub struct NativeOauthState {
    record: Mutex<Record>,
    store: Arc<Store<tauri::Wry>>,
    notifications: Mutex<CurrentListener<Channel<NativeOauthSignal>>>,
}

fn oauth_state(window: &WebviewWindow) -> Result<tauri::State<'_, NativeOauthState>, &'static str> {
    window
        .app_handle()
        .try_state::<NativeOauthState>()
        .ok_or("store_unavailable")
}

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn commit_record<T>(
    current: &mut Record,
    time: u64,
    action: impl FnOnce(&mut Record) -> Result<T, &'static str>,
    persist: impl FnOnce(&Record, &Record) -> Result<(), &'static str>,
) -> Result<T, &'static str> {
    let mut next = current.clone();
    next.cleanup(time);
    let result = action(&mut next)?;
    persist(&next, current)?;
    *current = next;
    Ok(result)
}

impl NativeOauthState {
    fn transact<T>(
        &self,
        action: impl FnOnce(&mut Record) -> Result<T, &'static str>,
    ) -> Result<T, &'static str> {
        let mut current = self.record.lock().map_err(|_| "store_unavailable")?;
        commit_record(&mut current, now(), action, |next, prior| {
            self.store.set(
                "record",
                serde_json::to_value(next).map_err(|_| "store_unavailable")?,
            );
            if self.store.save().is_err() {
                self.store.set(
                    "record",
                    serde_json::to_value(prior).map_err(|_| "store_unavailable")?,
                );
                return Err("store_unavailable");
            }
            Ok(())
        })
    }
    fn notify(&self, signal: NativeOauthSignal) {
        if let Ok(mut listeners) = self.notifications.lock() {
            listeners.notify(|channel| channel.send(signal).is_ok());
        }
    }
}

pub fn retire_listener(app: &AppHandle) {
    if let Some(state) = app.try_state::<NativeOauthState>() {
        if let Ok(mut listeners) = state.notifications.lock() {
            listeners.retire();
        }
    }
}

pub fn notify_listener(app: &AppHandle) {
    if let Some(state) = app.try_state::<NativeOauthState>() {
        state.notify(NativeOauthSignal::WindowResumed);
    }
}

fn intake(app: &AppHandle, url: &url::Url) {
    let Some(state) = app.try_state::<NativeOauthState>() else {
        return;
    };
    if state
        .transact(|record| record.intake(url, now()))
        .unwrap_or(false)
    {
        #[cfg(desktop)]
        crate::commands::show_main_window(app);
        state.notify(NativeOauthSignal::CandidateReady);
    }
}

pub fn setup(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let path = app.path().app_data_dir()?.join("native-oauth.json");
    std::fs::create_dir_all(path.parent().ok_or("store_unavailable")?)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .mode(0o600)
            .open(&path)?;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
    }
    let store = app.store_builder(path).disable_auto_save().build()?;
    let record = store
        .get("record")
        .and_then(|value| Record::restore(value, now()).ok())
        .map(Ok)
        .unwrap_or_else(Record::new)?;
    let state = NativeOauthState {
        record: Mutex::new(record),
        store,
        notifications: Mutex::new(CurrentListener::default()),
    };
    state.transact(|_| Ok(()))?;
    #[cfg(target_os = "linux")]
    app.deep_link().register_all()?;
    app.manage(state);
    let handle = app.clone();
    app.deep_link().on_open_url(move |event| {
        for url in event.urls() {
            intake(&handle, &url);
        }
    });
    if let Some(urls) = app.deep_link().get_current()? {
        for url in urls {
            intake(app, &url);
        }
    }
    Ok(())
}

#[tauri::command]
pub fn native_oauth_snapshot(window: WebviewWindow) -> Result<Option<Snapshot>, &'static str> {
    guard(&window)?;
    let state = oauth_state(&window)?;
    state.transact(|record| Ok(record.snapshot()))
}

#[tauri::command]
pub fn native_oauth_listen(
    window: WebviewWindow,
    channel: Channel<NativeOauthSignal>,
) -> Result<u64, &'static str> {
    guard(&window)?;
    let state = oauth_state(&window)?;
    let id = state
        .notifications
        .lock()
        .map_err(|_| "listener_unavailable")?
        .install(channel);
    Ok(id)
}

#[tauri::command]
pub fn native_oauth_unlisten(
    window: WebviewWindow,
    registration_id: u64,
) -> Result<(), &'static str> {
    guard(&window)?;
    let state = oauth_state(&window)?;
    state
        .notifications
        .lock()
        .map_err(|_| "listener_unavailable")?
        .remove(registration_id);
    Ok(())
}

#[tauri::command]
pub fn native_oauth_prepare(
    window: WebviewWindow,
    provider: String,
    redirect_path: String,
) -> Result<Registration, &'static str> {
    guard(&window)?;
    let state = oauth_state(&window)?;
    state.transact(|record| record.prepare(&provider, &redirect_path, std::env::consts::OS, now()))
}

#[tauri::command]
pub fn native_oauth_open_start(
    window: WebviewWindow,
    attempt_id: String,
    start_url: String,
) -> Result<(), &'static str> {
    guard(&window)?;
    let state = oauth_state(&window)?;
    state.transact(|record| record.open(&attempt_id, &start_url, tauri::is_dev()))?;
    if window
        .app_handle()
        .opener()
        .open_url(start_url, None::<&str>)
        .is_err()
    {
        let _ = state.transact(|record| {
            record.rollback_open(&attempt_id);
            Ok(())
        });
        return Err("browser_unavailable");
    }
    Ok(())
}

#[tauri::command]
pub fn native_oauth_pending_exchange(
    window: WebviewWindow,
) -> Result<Option<Exchange>, &'static str> {
    guard(&window)?;
    let state = oauth_state(&window)?;
    state.transact(|record| Ok(record.pending()))
}

#[tauri::command]
pub fn native_oauth_reject_candidate(
    window: WebviewWindow,
    attempt_id: String,
    candidate_id: String,
) -> Result<(), &'static str> {
    guard(&window)?;
    let state = oauth_state(&window)?;
    state.transact(|record| {
        record.reject(&attempt_id, &candidate_id);
        Ok(())
    })
}

#[tauri::command]
pub fn native_oauth_finish(
    window: WebviewWindow,
    attempt_id: String,
    candidate_id: String,
) -> Result<(), &'static str> {
    guard(&window)?;
    let state = oauth_state(&window)?;
    state.transact(|record| {
        record.finish(&attempt_id, &candidate_id);
        Ok(())
    })
}

#[tauri::command]
pub fn native_oauth_cancel(
    window: WebviewWindow,
    attempt_id: Option<String>,
) -> Result<Option<Proof>, &'static str> {
    guard(&window)?;
    let state = oauth_state(&window)?;
    state.transact(|record| {
        let id = attempt_id.or_else(|| record.snapshot().map(|a| a.attempt_id));
        match id {
            Some(id) => record.cancel(&id),
            None => Ok(None),
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::native_command_guard::caller_allowed;
    #[test]
    fn durable_commit_precedes_proof_release_and_notification() {
        let time = 1_000_000;
        let mut record = Record::new().unwrap();
        let attempt = record.prepare("github", "/c/me", "macos", time).unwrap();
        let before = serde_json::to_value(&record).unwrap();
        let failed = commit_record(
            &mut record,
            time,
            |r| r.cancel(&attempt.attempt_id),
            |_, _| Err("disk_full"),
        );
        assert!(matches!(failed, Err("disk_full")));
        assert_eq!(serde_json::to_value(&record).unwrap(), before);
        let mut disk = serde_json::Value::Null;
        let proof = commit_record(
            &mut record,
            time,
            |r| r.cancel(&attempt.attempt_id),
            |next, _| {
                disk = serde_json::to_value(next).unwrap();
                Ok(())
            },
        )
        .unwrap();
        assert!(proof.is_some());
        assert!(Record::restore(disk, time).unwrap().snapshot().is_none());
    }

    #[test]
    fn candidates_arriving_before_listener_or_after_failed_send_survive_reload() {
        let time = 1_000_000;
        let mut record = Record::new().unwrap();
        let attempt = record.prepare("github", "/c/me", "macos", time).unwrap();
        record
            .open(
                &attempt.attempt_id,
                &format!(
                    "https://alook.ai/auth/native/start?attempt={}",
                    attempt.attempt_id
                ),
                false,
            )
            .unwrap();
        let raw = format!(
            "ai.alook.desktop://auth/native/return?attempt={}&code={}",
            attempt.attempt_id,
            "c".repeat(32)
        );
        let mut disk = serde_json::Value::Null;
        let accepted = commit_record(
            &mut record,
            time,
            |r| r.intake(&url::Url::parse(&raw).unwrap(), time),
            |next, _| {
                disk = serde_json::to_value(next).unwrap();
                Ok(())
            },
        )
        .unwrap();
        assert!(accepted);
        let mut slots = CurrentListener::<()>::default();
        slots.notify(|_| panic!("not registered"));
        slots.install(());
        slots.notify(|_| false);
        let mut restored = Record::restore(disk, time).unwrap();
        assert!(restored.pending().is_some());
        assert!(!restored
            .intake(&url::Url::parse(&raw).unwrap(), time)
            .unwrap());
    }

    #[test]
    fn commands_require_main_and_exact_build_origin() {
        for (url, debug, expected) in [
            ("https://alook.ai/sign-in", false, true),
            ("http://localhost:3000/sign-in", true, true),
            ("http://localhost:3000/sign-in", false, false),
            ("https://alook.ai.evil.test", false, false),
            ("https://auth.alook.ai", false, false),
            ("https://alook.ai:8443", false, false),
            ("https://user@alook.ai", false, false),
        ] {
            let url = url::Url::parse(url).unwrap();
            assert_eq!(caller_allowed("main", &url, debug), expected);
            assert!(!caller_allowed("splash", &url, debug));
        }
    }

    #[test]
    fn oauth_signals_serialize_distinctly_for_callbacks_and_window_resumes() {
        assert_eq!(
            serde_json::to_value(NativeOauthSignal::CandidateReady).unwrap(),
            serde_json::json!("candidate_ready")
        );
        assert_eq!(
            serde_json::to_value(NativeOauthSignal::WindowResumed).unwrap(),
            serde_json::json!("window_resumed")
        );
    }

    #[test]
    fn rollback_open_reverts_waiting_while_keeping_cancel_proof_available() {
        let time = 1_000_000;
        let mut record = Record::new().unwrap();
        let attempt = record.prepare("github", "/c/me", "macos", time).unwrap();
        let start_url = format!(
            "https://alook.ai/auth/native/start?attempt={}",
            attempt.attempt_id
        );
        record.open(&attempt.attempt_id, &start_url, false).unwrap();
        assert_eq!(
            serde_json::to_value(record.snapshot()).unwrap()["waiting"],
            serde_json::json!(true)
        );
        record.rollback_open(&attempt.attempt_id);
        assert_eq!(
            serde_json::to_value(record.snapshot()).unwrap()["waiting"],
            serde_json::json!(false)
        );
        assert!(record.cancel(&attempt.attempt_id).unwrap().is_some());
        assert!(record.snapshot().is_none());
    }
}
