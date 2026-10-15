use crate::native_command_guard::guard;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::{Arc, Mutex};
use tauri::{ipc::Channel, AppHandle, Manager, WebviewWindow};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_store::{Store, StoreExt};

const RECORD_VERSION: u8 = 1;
const MAX_RECENT: usize = 256;
const ACTIVATION_SCHEME: &str = "ai.alook.desktop";
const ACTIVATION_HOST: &str = "notification";
const ACTIVATION_PATH: &str = "/open";

pub(crate) fn notification_diagnostics_enabled(app: &AppHandle) -> bool {
    cfg!(all(target_os = "macos", debug_assertions))
        && notification_diagnostic_identity_allowed(
            &app.config().identifier,
            std::env::var("ALOOK_NOTIFICATION_DIAGNOSTICS")
                .ok()
                .as_deref(),
        )
}

fn notification_diagnostic_identity_allowed(identifier: &str, switch: Option<&str>) -> bool {
    identifier == "ai.alook.desktop.qa.madox.notification208" && switch == Some("208")
}

macro_rules! notification_diagnostic {
    ($enabled:expr, $stage:expr, $data:expr) => {
        if $enabled {
            use std::io::Write;
            let time = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .ok()
                .map(|value| value.as_millis());
            let _ = writeln!(std::io::stderr().lock(), "ALOOK208 {}",
                serde_json::json!({ "stage": $stage, "timeMs": time, "data": $data }));
        }
    };
}

#[cfg(all(target_os = "macos", debug_assertions))]
pub(crate) fn diagnose_qa_startup(
    app: &AppHandle,
    phase: &str,
    window: &str,
    result: serde_json::Value,
) {
    notification_diagnostic!(
        notification_diagnostics_enabled(app),
        "native_startup",
        serde_json::json!({
            "phase": phase,
            "window": window,
            "pid": std::process::id(),
            "result": result,
        })
    );
}

#[cfg(any(test, all(target_os = "macos", debug_assertions)))]
fn sanitized_startup_url(mut url: url::Url) -> Result<String, &'static str> {
    url.set_query(None);
    url.set_fragment(None);
    if url.password().is_some() {
        url.set_password(None)
            .map_err(|_| "password_sanitization_failed")?;
    }
    if !url.username().is_empty() {
        url.set_username("")
            .map_err(|_| "username_sanitization_failed")?;
    }
    Ok(url.to_string())
}

#[cfg(all(target_os = "macos", debug_assertions))]
pub(crate) fn diagnose_qa_main_snapshot(window: &WebviewWindow) {
    if !notification_diagnostics_enabled(window.app_handle()) {
        return;
    }
    let visible = window.is_visible();
    diagnose_qa_startup(
        window.app_handle(),
        "main_visible_return",
        window.label(),
        match visible {
            Ok(value) => serde_json::json!({ "status": "ok", "visible": value }),
            Err(error) => serde_json::json!({ "status": "error", "error": error.to_string() }),
        },
    );
    let url = window.url();
    diagnose_qa_startup(
        window.app_handle(),
        "main_url_return",
        window.label(),
        match url {
            Ok(value) => match sanitized_startup_url(value) {
                Ok(value) => serde_json::json!({ "status": "ok", "url": value }),
                Err(error) => serde_json::json!({ "status": "sanitization_error", "error": error }),
            },
            Err(error) => serde_json::json!({ "status": "error", "error": error.to_string() }),
        },
    );
}

#[cfg(all(target_os = "macos", debug_assertions))]
fn log_qa_store_identity(
    window: &str,
    identifier: Option<String>,
    read_time_ms: Option<u128>,
    error: Option<String>,
) {
    notification_diagnostic!(
        true,
        "native_store_identity",
        serde_json::json!({
            "window": window,
            "pid": std::process::id(),
            "identifier": identifier,
            "readTimeMs": read_time_ms,
            "error": error,
        })
    );
}

#[cfg(all(target_os = "macos", debug_assertions))]
pub(crate) fn diagnose_qa_store(window: &WebviewWindow) {
    use objc2::MainThreadMarker;
    use objc2_web_kit::WKWebView;

    if !notification_diagnostics_enabled(window.app_handle()) {
        return;
    }
    let label = window.label().to_owned();
    if !objc2::available!(macos = 14.0) {
        log_qa_store_identity(&label, None, None, Some("macos_14_required".into()));
        return;
    }
    let callback_label = label.clone();
    if let Err(error) = window.with_webview(move |platform| {
        if MainThreadMarker::new().is_none() {
            log_qa_store_identity(&callback_label, None, None, Some("not_main_thread".into()));
            return;
        }
        let Some(webview) = (unsafe { platform.inner().cast::<WKWebView>().as_ref() }) else {
            log_qa_store_identity(
                &callback_label,
                None,
                None,
                Some("webview_unavailable".into()),
            );
            return;
        };
        let identifier = unsafe { webview.configuration().websiteDataStore().identifier() }
            .map(|value| value.UUIDString().to_string());
        let read_time_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .ok()
            .map(|value| value.as_millis());
        let error = read_time_ms
            .is_none()
            .then(|| "read_clock_unavailable".into());
        log_qa_store_identity(&callback_label, identifier, read_time_ms, error);
    }) {
        log_qa_store_identity(&label, None, None, Some(error.to_string()));
    }
}
#[cfg(windows)]
const WINDOWS_APP_ID: &str = "ai.alook.desktop";
#[cfg(windows)]
const WINDOWS_NOTIFICATION_GROUP: &str = "messages";

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub enum NotificationTarget {
    Server {
        #[serde(rename = "serverId")]
        server_id: String,
        #[serde(rename = "channelId")]
        channel_id: String,
        #[serde(rename = "messageId")]
        message_id: String,
        seq: u64,
    },
    Dm {
        #[serde(rename = "channelId")]
        channel_id: String,
        #[serde(rename = "messageId")]
        message_id: String,
        seq: u64,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub enum NotificationConversation {
    Server {
        #[serde(rename = "serverId")]
        server_id: String,
        #[serde(rename = "channelId")]
        channel_id: String,
    },
    Dm {
        #[serde(rename = "channelId")]
        channel_id: String,
    },
}

impl NotificationConversation {
    fn valid(&self) -> bool {
        match self {
            Self::Server {
                server_id,
                channel_id,
            } => valid_id(server_id) && valid_id(channel_id),
            Self::Dm { channel_id } => valid_id(channel_id),
        }
    }

    fn matches(&self, target: &NotificationTarget) -> bool {
        match (self, target) {
            (
                Self::Server {
                    server_id,
                    channel_id,
                },
                NotificationTarget::Server {
                    server_id: target_server,
                    channel_id: target_channel,
                    ..
                },
            ) => server_id == target_server && channel_id == target_channel,
            (
                Self::Dm { channel_id },
                NotificationTarget::Dm {
                    channel_id: target_channel,
                    ..
                },
            ) => channel_id == target_channel,
            _ => false,
        }
    }
}

impl NotificationTarget {
    #[cfg(any(target_os = "macos", test))]
    fn channel_id(&self) -> &str {
        match self {
            Self::Server { channel_id, .. } | Self::Dm { channel_id, .. } => channel_id,
        }
    }

    fn message_id(&self) -> &str {
        match self {
            Self::Server { message_id, .. } | Self::Dm { message_id, .. } => message_id,
        }
    }

    fn valid(&self) -> bool {
        match self {
            Self::Server {
                server_id,
                channel_id,
                message_id,
                seq,
            } => valid_id(server_id) && valid_id(channel_id) && valid_id(message_id) && *seq > 0,
            Self::Dm {
                channel_id,
                message_id,
                seq,
            } => valid_id(channel_id) && valid_id(message_id) && *seq > 0,
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NotificationCandidate {
    viewer_user_id: String,
    title: String,
    body: String,
    target: NotificationTarget,
}

impl NotificationCandidate {
    fn valid(&self) -> bool {
        valid_id(&self.viewer_user_id)
            && !self.title.trim().is_empty()
            && self.title.chars().count() <= 256
            && !self.body.trim().is_empty()
            && self.body.chars().count() <= 512
            && self.target.valid()
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NotificationActivation {
    notification_id: String,
    target: NotificationTarget,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RecentNotification {
    notification_id: String,
    viewer_user_id: String,
    message_id: String,
    target: NotificationTarget,
    activated: bool,
    #[serde(default)]
    dismissed: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct NotificationRecord {
    version: u8,
    recent: Vec<RecentNotification>,
}

impl NotificationRecord {
    fn new() -> Self {
        Self {
            version: RECORD_VERSION,
            recent: Vec::new(),
        }
    }

    fn restore(value: serde_json::Value) -> Result<Self, &'static str> {
        let record: Self = serde_json::from_value(value).map_err(|_| "store_invalid")?;
        if record.version != RECORD_VERSION
            || record.recent.len() > MAX_RECENT
            || record.recent.iter().any(|item| {
                !valid_notification_id(&item.notification_id)
                    || !valid_id(&item.viewer_user_id)
                    || !valid_id(&item.message_id)
                    || item.message_id != item.target.message_id()
                    || !item.target.valid()
            })
        {
            return Err("store_invalid");
        }
        Ok(record)
    }

    fn claim(&mut self, candidate: &NotificationCandidate) -> Option<String> {
        if !candidate.valid() {
            return None;
        }
        let notification_id =
            deterministic_notification_id(&candidate.viewer_user_id, candidate.target.message_id());
        if self.recent.iter().any(|item| {
            item.notification_id == notification_id
                || (item.viewer_user_id == candidate.viewer_user_id
                    && item.message_id == candidate.target.message_id())
        }) {
            return None;
        }
        self.recent.push(RecentNotification {
            notification_id: notification_id.clone(),
            viewer_user_id: candidate.viewer_user_id.clone(),
            message_id: candidate.target.message_id().to_string(),
            target: candidate.target.clone(),
            activated: false,
            dismissed: false,
        });
        if self.recent.len() > MAX_RECENT {
            self.recent.drain(0..self.recent.len() - MAX_RECENT);
        }
        Some(notification_id)
    }

    fn rollback(&mut self, notification_id: &str) {
        self.recent
            .retain(|item| item.notification_id != notification_id);
    }

    fn activate(&mut self, notification_id: &str) -> Option<NotificationActivation> {
        let item = self
            .recent
            .iter_mut()
            .find(|item| item.notification_id == notification_id && !item.activated)?;
        item.activated = true;
        Some(NotificationActivation {
            notification_id: item.notification_id.clone(),
            target: item.target.clone(),
        })
    }

    fn retry_activation(&mut self, notification_id: &str) -> bool {
        let Some(item) = self
            .recent
            .iter_mut()
            .find(|item| item.notification_id == notification_id && item.activated)
        else {
            return false;
        };
        item.activated = false;
        true
    }

    #[cfg(any(target_os = "macos", test))]
    fn presentation_identity(&self, notification_id: &str) -> Option<(String, String)> {
        self.recent
            .iter()
            .find(|item| item.notification_id == notification_id)
            .map(|item| {
                (
                    item.viewer_user_id.clone(),
                    item.target.channel_id().to_string(),
                )
            })
    }

    fn notification_ids(
        &self,
        viewer_user_id: &str,
        conversation: &NotificationConversation,
    ) -> Vec<String> {
        self.recent
            .iter()
            .filter(|item| {
                !item.dismissed
                    && item.viewer_user_id == viewer_user_id
                    && conversation.matches(&item.target)
            })
            .map(|item| item.notification_id.clone())
            .collect()
    }

    fn complete_dismissals(&mut self, notification_ids: &[String]) {
        for item in &mut self.recent {
            if notification_ids.contains(&item.notification_id) {
                item.dismissed = true;
            }
        }
    }
}

struct Notifications<T> {
    next_id: u64,
    current: Option<(u64, T)>,
}

impl<T> Default for Notifications<T> {
    fn default() -> Self {
        Self {
            next_id: 0,
            current: None,
        }
    }
}

impl<T> Notifications<T> {
    fn install(&mut self, channel: T) -> u64 {
        self.next_id += 1;
        self.current = Some((self.next_id, channel));
        self.next_id
    }

    fn remove(&mut self, id: u64) {
        if self
            .current
            .as_ref()
            .is_some_and(|(current, _)| *current == id)
        {
            self.current = None;
        }
    }

    fn notify(&mut self, send: impl FnOnce(&T) -> bool) {
        if self
            .current
            .as_ref()
            .is_some_and(|(_, channel)| !send(channel))
        {
            self.current = None;
        }
    }
}

pub struct DesktopSystemNotificationState {
    record: Mutex<NotificationRecord>,
    store: Arc<Store<tauri::Wry>>,
    notifications: Mutex<Notifications<Channel<()>>>,
    pending: Mutex<Option<NotificationActivation>>,
}

impl DesktopSystemNotificationState {
    fn transact<T>(
        &self,
        action: impl FnOnce(&mut NotificationRecord) -> Result<T, &'static str>,
    ) -> Result<T, &'static str> {
        let mut current = self.record.lock().map_err(|_| "store_unavailable")?;
        let mut next = current.clone();
        let result = action(&mut next)?;
        self.store.set(
            "record",
            serde_json::to_value(&next).map_err(|_| "store_unavailable")?,
        );
        if self.store.save().is_err() {
            self.store.set(
                "record",
                serde_json::to_value(&*current).map_err(|_| "store_unavailable")?,
            );
            return Err("store_unavailable");
        }
        *current = next;
        Ok(result)
    }

    fn notify(&self) {
        if let Ok(mut listeners) = self.notifications.lock() {
            listeners.notify(|channel| channel.send(()).is_ok());
        }
    }
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn valid_notification_id(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => byte == b'-',
            _ => byte.is_ascii_hexdigit(),
        })
}

fn deterministic_notification_id(viewer_user_id: &str, message_id: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(b"alook:desktop-notification:v1\0");
    digest.update(viewer_user_id.as_bytes());
    digest.update(b"\0");
    digest.update(message_id.as_bytes());
    let mut bytes: [u8; 16] = digest.finalize()[..16].try_into().expect("fixed digest");
    bytes[6] = (bytes[6] & 0x0f) | 0x50;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
        bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]
    )
}

fn activation_id_from_url(url: &url::Url) -> Option<String> {
    if url.scheme() != ACTIVATION_SCHEME
        || url.host_str() != Some(ACTIVATION_HOST)
        || url.path() != ACTIVATION_PATH
        || url.username() != ""
        || url.password().is_some()
        || url.port().is_some()
        || url.fragment().is_some()
    {
        return None;
    }
    let mut pairs = url.query_pairs();
    let (key, value) = pairs.next()?;
    if key != "id" || pairs.next().is_some() || !valid_notification_id(&value) {
        return None;
    }
    Some(value.into_owned())
}

fn activate(app: &AppHandle, notification_id: &str) {
    let Some(state) = app.try_state::<DesktopSystemNotificationState>() else {
        return;
    };
    let Ok(Some(activation)) = state.transact(|record| Ok(record.activate(notification_id))) else {
        return;
    };
    if let Ok(mut pending) = state.pending.lock() {
        *pending = Some(activation);
    } else {
        return;
    }
    crate::commands::show_main_window(app);
    state.notify();
}

fn intake(app: &AppHandle, url: &url::Url) {
    if let Some(notification_id) = activation_id_from_url(url) {
        activate(app, &notification_id);
    }
}

pub fn intake_args(app: &AppHandle, args: &[String]) {
    for url in args.iter().filter_map(|arg| url::Url::parse(arg).ok()) {
        intake(app, &url);
    }
}

pub fn setup(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let path = app
        .path()
        .app_data_dir()?
        .join("desktop-system-notifications.json");
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
        .and_then(|value| NotificationRecord::restore(value).ok())
        .unwrap_or_else(NotificationRecord::new);
    let state = DesktopSystemNotificationState {
        record: Mutex::new(record),
        store,
        notifications: Mutex::new(Notifications::default()),
        pending: Mutex::new(None),
    };
    state.transact(|_| Ok(()))?;
    app.manage(state);

    #[cfg(target_os = "macos")]
    install_macos_delegate(app);

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

pub fn retire_listener(app: &AppHandle) {
    if let Some(state) = app.try_state::<DesktopSystemNotificationState>() {
        if let Ok(mut listeners) = state.notifications.lock() {
            listeners.current = None;
        }
    }
}

#[tauri::command]
pub async fn desktop_system_notification_show(
    window: WebviewWindow,
    state: tauri::State<'_, DesktopSystemNotificationState>,
    candidate: NotificationCandidate,
) -> Result<(), &'static str> {
    let diagnostics = notification_diagnostics_enabled(window.app_handle());
    let guarded = guard(&window);
    notification_diagnostic!(
        diagnostics,
        "native.show.guard",
        serde_json::json!({"result": guarded})
    );
    guarded?;
    let valid = candidate.valid();
    notification_diagnostic!(
        diagnostics,
        "native.show.payload",
        serde_json::json!({"valid": valid})
    );
    if !valid {
        return Err("notification_invalid");
    }
    let claimed = state.transact(|record| Ok(record.claim(&candidate)));
    notification_diagnostic!(
        diagnostics,
        "native.show.claim",
        serde_json::json!({
            "viewerUserId": candidate.viewer_user_id, "target": candidate.target, "result": claimed
        })
    );
    let Some(notification_id) = claimed? else {
        return Ok(());
    };
    let displayed = display_notification(
        window.app_handle(),
        &notification_id,
        &candidate.title,
        &candidate.body,
    )
    .await;
    notification_diagnostic!(
        diagnostics,
        "native.show.return",
        serde_json::json!({
            "notificationId": notification_id, "result": displayed
        })
    );
    if displayed.is_err() {
        let rolled_back = state.transact(|record| {
            record.rollback(&notification_id);
            Ok(())
        });
        notification_diagnostic!(
            diagnostics,
            "native.show.rollback",
            serde_json::json!({
                "notificationId": notification_id, "result": rolled_back
            })
        );
        rolled_back?;
        return Err("notification_unavailable");
    }
    #[cfg(any(windows, target_os = "linux"))]
    state.notify();
    Ok(())
}

#[tauri::command]
pub fn desktop_system_notification_listen(
    window: WebviewWindow,
    channel: Channel<()>,
) -> Result<u64, &'static str> {
    guard(&window)?;
    let state = window
        .app_handle()
        .try_state::<DesktopSystemNotificationState>()
        .ok_or("store_unavailable")?;
    let id = state
        .notifications
        .lock()
        .map_err(|_| "listener_unavailable")?
        .install(channel);
    Ok(id)
}

#[tauri::command]
pub fn desktop_system_notification_unlisten(
    window: WebviewWindow,
    state: tauri::State<'_, DesktopSystemNotificationState>,
    registration_id: u64,
) -> Result<(), &'static str> {
    guard(&window)?;
    state
        .notifications
        .lock()
        .map_err(|_| "listener_unavailable")?
        .remove(registration_id);
    Ok(())
}

#[tauri::command]
pub fn desktop_system_notification_take_activation(
    window: WebviewWindow,
    state: tauri::State<'_, DesktopSystemNotificationState>,
) -> Result<Option<NotificationActivation>, &'static str> {
    guard(&window)?;
    Ok(state
        .pending
        .lock()
        .map_err(|_| "activation_unavailable")?
        .take())
}

#[tauri::command]
pub fn desktop_system_notification_retry_activation(
    window: WebviewWindow,
    state: tauri::State<'_, DesktopSystemNotificationState>,
    notification_id: String,
) -> Result<(), &'static str> {
    guard(&window)?;
    if !valid_notification_id(&notification_id) {
        return Err("notification_invalid");
    }
    state.transact(|record| {
        if record.retry_activation(&notification_id) {
            Ok(())
        } else {
            Err("activation_unavailable")
        }
    })
}

#[tauri::command]
pub async fn desktop_system_notification_dismiss(
    window: WebviewWindow,
    state: tauri::State<'_, DesktopSystemNotificationState>,
    notification_id: String,
) -> Result<(), &'static str> {
    let diagnostics = notification_diagnostics_enabled(window.app_handle());
    let guarded = guard(&window);
    notification_diagnostic!(
        diagnostics,
        "native.id.guard",
        serde_json::json!({
            "notificationId": notification_id, "result": guarded
        })
    );
    guarded?;
    let valid = valid_notification_id(&notification_id);
    notification_diagnostic!(
        diagnostics,
        "native.id.payload",
        serde_json::json!({"valid": valid})
    );
    if !valid {
        return Err("notification_invalid");
    }
    dismiss_notifications_confirmed(&[notification_id.clone()], diagnostics)
        .await
        .map_err(|_| "notification_unavailable")?;
    let completed = state.transact(|record| {
        record.complete_dismissals(&[notification_id]);
        Ok(())
    });
    notification_diagnostic!(
        diagnostics,
        "native.id.transact",
        serde_json::json!({"result": completed})
    );
    completed
}

#[tauri::command]
pub async fn desktop_system_notification_dismiss_conversation(
    window: WebviewWindow,
    state: tauri::State<'_, DesktopSystemNotificationState>,
    viewer_user_id: String,
    target: NotificationConversation,
) -> Result<(), &'static str> {
    let diagnostics = notification_diagnostics_enabled(window.app_handle());
    let guarded = guard(&window);
    notification_diagnostic!(
        diagnostics,
        "native.conversation.guard",
        serde_json::json!({
            "viewerUserId": viewer_user_id, "target": target, "result": guarded
        })
    );
    guarded?;
    let valid = valid_id(&viewer_user_id) && target.valid();
    notification_diagnostic!(
        diagnostics,
        "native.conversation.payload",
        serde_json::json!({"valid": valid})
    );
    if !valid {
        return Err("notification_invalid");
    }
    let notification_ids = {
        let record = state.record.lock().map_err(|_| "store_unavailable")?;
        let ids = record.notification_ids(&viewer_user_id, &target);
        notification_diagnostic!(
            diagnostics,
            "native.conversation.mapping",
            serde_json::json!({
                "matchingRecords": record.recent.iter().filter(|item| item.viewer_user_id == viewer_user_id
                    && target.matches(&item.target)).collect::<Vec<_>>()
            })
        );
        ids
    };
    notification_diagnostic!(
        diagnostics,
        "native.conversation.select",
        serde_json::json!({
            "viewerUserId": viewer_user_id, "target": target, "notificationIds": notification_ids
        })
    );
    if notification_ids.is_empty() {
        return Ok(());
    }
    dismiss_notifications_confirmed(&notification_ids, diagnostics)
        .await
        .map_err(|_| "notification_unavailable")?;
    let completed = state.transact(|record| {
        record.complete_dismissals(&notification_ids);
        Ok(())
    });
    notification_diagnostic!(
        diagnostics,
        "native.conversation.transact",
        serde_json::json!({
            "notificationIds": notification_ids, "result": completed
        })
    );
    completed
}

#[cfg(target_os = "macos")]
async fn notification_diagnostic_pending(stage: &'static str) {
    use block2::RcBlock;
    use objc2_foundation::NSArray;
    use objc2_user_notifications::{UNNotificationRequest, UNUserNotificationCenter};
    use std::ptr::NonNull;

    let receiver = {
        let (sender, receiver) = std::sync::mpsc::channel();
        let completion = RcBlock::new(move |requests: NonNull<NSArray<UNNotificationRequest>>| {
            let ids = unsafe { requests.as_ref() }
                .iter()
                .map(|request| request.identifier().to_string())
                .collect::<Vec<_>>();
            notification_diagnostic!(true, stage, serde_json::json!({"pendingIds": ids}));
            let _ = sender.send(Ok(()));
        });
        UNUserNotificationCenter::currentNotificationCenter()
            .getPendingNotificationRequestsWithCompletionHandler(&completion);
        receiver
    };
    let result = wait_for_macos_completion(receiver).await;
    notification_diagnostic!(
        true,
        "os.pending.wait",
        serde_json::json!({"stage": stage, "result": result})
    );
}

#[cfg(target_os = "macos")]
async fn dismiss_notifications_confirmed(
    notification_ids: &[String],
    diagnostics: bool,
) -> Result<(), ()> {
    use block2::RcBlock;
    use objc2_foundation::{NSArray, NSString};
    use objc2_user_notifications::{UNNotification, UNUserNotificationCenter};
    use std::ptr::NonNull;

    if diagnostics {
        notification_diagnostic_pending("os.pending.before").await;
        let receiver = {
            let (sender, receiver) = std::sync::mpsc::channel();
            let completion =
                RcBlock::new(move |notifications: NonNull<NSArray<UNNotification>>| {
                    let ids = unsafe { notifications.as_ref() }
                        .iter()
                        .map(|notification| notification.request().identifier().to_string())
                        .collect::<Vec<_>>();
                    notification_diagnostic!(
                        true,
                        "os.delivered.before",
                        serde_json::json!({"deliveredIds": ids})
                    );
                    let _ = sender.send(Ok(()));
                });
            UNUserNotificationCenter::currentNotificationCenter()
                .getDeliveredNotificationsWithCompletionHandler(&completion);
            receiver
        };
        let result = wait_for_macos_completion(receiver).await;
        notification_diagnostic!(
            true,
            "os.delivered.before.wait",
            serde_json::json!({"result": result})
        );
    }
    let receiver = {
        let identifiers = notification_ids
            .iter()
            .map(|value| NSString::from_str(value))
            .collect::<Vec<_>>();
        let identifier_refs = identifiers.iter().map(|value| &**value).collect::<Vec<_>>();
        let center = UNUserNotificationCenter::currentNotificationCenter();
        notification_diagnostic!(
            diagnostics,
            "os.removeDelivered.call",
            serde_json::json!({"notificationIds": notification_ids})
        );
        center.removeDeliveredNotificationsWithIdentifiers(&NSArray::from_slice(&identifier_refs));
        let requested = notification_ids.to_vec();
        let (sender, receiver) = std::sync::mpsc::channel();
        let completion = RcBlock::new(move |notifications: NonNull<NSArray<UNNotification>>| {
            let notifications = unsafe { notifications.as_ref() };
            let remains = notifications.iter().any(|notification| {
                requested.contains(&notification.request().identifier().to_string())
            });
            notification_diagnostic!(
                diagnostics,
                "os.delivered.originalCallback",
                serde_json::json!({
                    "requestedIds": requested, "remains": remains,
                    "deliveredIds": notifications.iter().map(|notification| notification.request().identifier().to_string()).collect::<Vec<_>>()
                })
            );
            let _ = sender.send(if remains { Err(()) } else { Ok(()) });
        });
        center.getDeliveredNotificationsWithCompletionHandler(&completion);
        receiver
    };
    let result = wait_for_macos_completion(receiver).await;
    notification_diagnostic!(
        diagnostics,
        "native.dismiss.originalResult",
        serde_json::json!({"notificationIds": notification_ids, "result": result})
    );
    if diagnostics {
        notification_diagnostic_pending("os.pending.after").await;
    }
    result
}

#[cfg(windows)]
async fn dismiss_notifications_confirmed(
    notification_ids: &[String],
    _diagnostics: bool,
) -> Result<(), ()> {
    use windows::core::HSTRING;
    use windows::UI::Notifications::ToastNotificationManager;

    let history = ToastNotificationManager::History().map_err(|_| ())?;
    for notification_id in notification_ids {
        history
            .RemoveGroupedTagWithId(
                &HSTRING::from(notification_id.as_str()),
                &HSTRING::from(WINDOWS_NOTIFICATION_GROUP),
                &HSTRING::from(WINDOWS_APP_ID),
            )
            .map_err(|_| ())?;
    }
    let delivered = history
        .GetHistoryWithId(&HSTRING::from(WINDOWS_APP_ID))
        .map_err(|_| ())?;
    for index in 0..delivered.Size().map_err(|_| ())? {
        let toast = delivered.GetAt(index).map_err(|_| ())?;
        let tag = toast.Tag().map_err(|_| ())?.to_string();
        let group = toast.Group().map_err(|_| ())?.to_string();
        if group == WINDOWS_NOTIFICATION_GROUP && notification_ids.contains(&tag) {
            return Err(());
        }
    }
    Ok(())
}

#[cfg(target_os = "linux")]
async fn dismiss_notifications_confirmed(
    _notification_ids: &[String],
    _diagnostics: bool,
) -> Result<(), ()> {
    Err(())
}

#[cfg(target_os = "macos")]
async fn display_notification(
    app: &AppHandle,
    notification_id: &str,
    title: &str,
    body: &str,
) -> Result<(), ()> {
    use block2::RcBlock;
    use objc2::runtime::Bool;
    use objc2_foundation::{NSError, NSString};
    use objc2_user_notifications::{
        UNAuthorizationOptions, UNMutableNotificationContent, UNNotificationRequest,
        UNNotificationSound, UNUserNotificationCenter,
    };

    let authorization = {
        let (sender, receiver) = std::sync::mpsc::channel();
        let completion = RcBlock::new(move |granted: Bool, error: *mut NSError| {
            let _ = sender.send(macos_authorization_result(
                granted.as_bool(),
                !error.is_null(),
            ));
        });
        UNUserNotificationCenter::currentNotificationCenter()
            .requestAuthorizationWithOptions_completionHandler(
                UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound,
                &completion,
            );
        receiver
    };
    let authorized = wait_for_macos_completion(authorization).await;
    let diagnostics = notification_diagnostics_enabled(app);
    notification_diagnostic!(
        diagnostics,
        "os.add.authorization",
        serde_json::json!({"notificationId": notification_id, "result": authorized})
    );
    authorized?;

    let scheduled = {
        let center = UNUserNotificationCenter::currentNotificationCenter();
        let content = UNMutableNotificationContent::new();
        content.setTitle(&NSString::from_str(title));
        content.setBody(&NSString::from_str(body));
        content.setSound(Some(&UNNotificationSound::defaultSound()));
        let request = UNNotificationRequest::requestWithIdentifier_content_trigger(
            &NSString::from_str(notification_id),
            &content,
            None,
        );
        let (sender, receiver) = std::sync::mpsc::channel();
        let id = notification_id.to_string();
        let completion = RcBlock::new(move |error: *mut NSError| {
            notification_diagnostic!(
                diagnostics,
                "os.add.originalCallback",
                serde_json::json!({"notificationId": id, "hasError": !error.is_null()})
            );
            let _ = sender.send(macos_add_result(!error.is_null()));
        });
        center.addNotificationRequest_withCompletionHandler(&request, Some(&completion));
        receiver
    };
    wait_for_macos_completion(scheduled).await
}

#[cfg(any(target_os = "macos", test))]
fn macos_authorization_result(granted: bool, has_error: bool) -> Result<(), ()> {
    if granted && !has_error {
        Ok(())
    } else {
        Err(())
    }
}

#[cfg(any(target_os = "macos", test))]
fn macos_add_result(has_error: bool) -> Result<(), ()> {
    if has_error {
        Err(())
    } else {
        Ok(())
    }
}

#[cfg(target_os = "macos")]
async fn wait_for_macos_completion(
    receiver: std::sync::mpsc::Receiver<Result<(), ()>>,
) -> Result<(), ()> {
    tauri::async_runtime::spawn_blocking(move || receiver.recv().unwrap_or(Err(())))
        .await
        .map_err(|_| ())?
}

#[cfg(target_os = "macos")]
struct SendablePresentationCompletion(
    block2::RcBlock<dyn Fn(objc2_user_notifications::UNNotificationPresentationOptions)>,
);

// SAFETY: This is only Apple's escaping UN presentation completion. Apple permits
// its invocation from any queue. The owned heap copy is taken once under a mutex;
// no WebKit object, arbitrary block, or borrowed delegate value crosses threads.
#[cfg(target_os = "macos")]
unsafe impl Send for SendablePresentationCompletion {}

#[cfg(target_os = "macos")]
struct PresentationCompletion {
    pending: Mutex<Option<SendablePresentationCompletion>>,
    deadline: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
}

#[cfg(target_os = "macos")]
impl PresentationCompletion {
    fn new(owned: SendablePresentationCompletion) -> Arc<Self> {
        let decision = Arc::new(Self {
            pending: Mutex::new(Some(owned)),
            deadline: Mutex::new(None),
        });
        let deadline_decision = decision.clone();
        let deadline = tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            deadline_decision.finish(false);
        });
        {
            let mut slot = decision
                .deadline
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            if decision
                .pending
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .is_some()
            {
                *slot = Some(deadline);
            } else {
                deadline.abort();
            }
        }
        decision
    }

    fn finish(&self, suppress: bool) -> bool {
        let completion = self
            .pending
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take();
        let Some(completion) = completion else {
            return false;
        };
        if let Some(deadline) = self
            .deadline
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take()
        {
            deadline.abort();
        }
        completion.0.call((macos_presentation_options(suppress),));
        true
    }
}

#[cfg(target_os = "macos")]
impl Drop for PresentationCompletion {
    fn drop(&mut self) {
        self.finish(false);
    }
}

#[cfg(target_os = "macos")]
fn macos_presentation_options(
    suppress: bool,
) -> objc2_user_notifications::UNNotificationPresentationOptions {
    use objc2_user_notifications::UNNotificationPresentationOptions as Options;
    if suppress {
        Options::empty()
    } else {
        Options::Banner | Options::List | Options::Sound
    }
}

#[cfg(target_os = "macos")]
fn decide_macos_presentation(
    app: &AppHandle,
    identifier: String,
    completion: &block2::DynBlock<
        dyn Fn(objc2_user_notifications::UNNotificationPresentationOptions),
    >,
) {
    use block2::RcBlock;
    use objc2::{runtime::AnyObject, MainThreadMarker};
    use objc2_foundation::{NSError, NSString};
    use objc2_web_kit::WKWebView;

    let identity = app
        .try_state::<DesktopSystemNotificationState>()
        .and_then(|state| state.record.lock().ok()?.presentation_identity(&identifier));
    let Some((viewer, target)) = identity else {
        completion.call((macos_presentation_options(false),));
        return;
    };
    // SAFETY: The delegate supplies a valid block with this exact signature.
    // Heap-copy it before returning from the delegate callback.
    let owned = unsafe { RcBlock::copy(completion as *const _ as *mut _) };
    let Some(owned) = owned else {
        completion.call((macos_presentation_options(false),));
        return;
    };
    let decision = PresentationCompletion::new(SendablePresentationCompletion(owned));
    let Some(window) = app.get_webview_window("main") else {
        decision.finish(false);
        return;
    };
    let identity = serde_json::json!({ "viewerUserId": viewer, "targetId": target });
    let script = format!("(()=>{{try{{return window.alookNativeNotificationPresentationV1?.({identity})===true?'suppress':'present'}}catch{{return 'present'}}}})()");
    let main_decision = decision.clone();
    let app = app.clone();
    if window
        .with_webview(move |platform| {
            if MainThreadMarker::new().is_none() {
                main_decision.finish(false);
                return;
            }
            let result_decision = main_decision.clone();
            let callback = RcBlock::new(move |result: *mut AnyObject, error: *mut NSError| {
                // SAFETY: WK owns these callback arguments until this invocation ends.
                let suppress = error.is_null()
                    && unsafe { result.as_ref() }
                        .and_then(|value| value.downcast_ref::<NSString>())
                        .is_some_and(|value| value.to_string() == "suppress");
                if result_decision.finish(suppress) && suppress {
                    if let Some(state) = app.try_state::<DesktopSystemNotificationState>() {
                        let _ = state.transact(|record| {
                            record.complete_dismissals(&[identifier.clone()]);
                            Ok(())
                        });
                    }
                }
            });
            // SAFETY: Tauri supplies the live WKWebView on the main thread. This
            // borrowed pointer is used only here; WK copies its escaping completion.
            unsafe {
                let webview = &*platform.inner().cast::<WKWebView>();
                webview.evaluateJavaScript_completionHandler(
                    &NSString::from_str(&script),
                    Some(&callback),
                );
            }
        })
        .is_err()
    {
        decision.finish(false);
    }
}

#[cfg(target_os = "macos")]
fn install_macos_delegate(app: &AppHandle) {
    use block2::DynBlock;
    use objc2::rc::Retained;
    use objc2::runtime::ProtocolObject;
    use objc2::{define_class, msg_send, AnyThread, DefinedClass};
    use objc2_foundation::{NSObject, NSObjectProtocol};
    use objc2_user_notifications::{
        UNNotification, UNNotificationPresentationOptions, UNNotificationResponse,
        UNUserNotificationCenter, UNUserNotificationCenterDelegate,
    };

    struct DelegateIvars {
        app: AppHandle,
    }

    define_class!(
        #[unsafe(super = NSObject)]
        #[thread_kind = AnyThread]
        #[ivars = DelegateIvars]
        struct Delegate;

        unsafe impl NSObjectProtocol for Delegate {}

        unsafe impl UNUserNotificationCenterDelegate for Delegate {
            #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
            fn will_present(
                &self,
                _center: &UNUserNotificationCenter,
                notification: &UNNotification,
                completion: &DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
            ) {
                decide_macos_presentation(
                    &self.ivars().app,
                    notification.request().identifier().to_string(),
                    completion,
                );
            }

            #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
            fn did_receive(
                &self,
                _center: &UNUserNotificationCenter,
                response: &UNNotificationResponse,
                completion: &DynBlock<dyn Fn()>,
            ) {
                let identifier = response.notification().request().identifier().to_string();
                activate(&self.ivars().app, &identifier);
                completion.call(());
            }
        }
    );

    impl Delegate {
        fn new(app: AppHandle) -> Retained<Self> {
            let this = Self::alloc().set_ivars(DelegateIvars { app });
            unsafe { msg_send![super(this), init] }
        }
    }

    let delegate = Delegate::new(app.clone());
    UNUserNotificationCenter::currentNotificationCenter()
        .setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
    std::mem::forget(delegate);
}

#[cfg(windows)]
async fn display_notification(
    _app: &AppHandle,
    notification_id: &str,
    title: &str,
    body: &str,
) -> Result<(), ()> {
    use windows::core::HSTRING;
    use windows::Data::Xml::Dom::XmlDocument;
    use windows::UI::Notifications::{ToastNotification, ToastNotificationManager};

    let launch =
        format!("{ACTIVATION_SCHEME}://{ACTIVATION_HOST}{ACTIVATION_PATH}?id={notification_id}");
    let xml = format!(
        "<toast activationType=\"protocol\" launch=\"{}\"><visual><binding template=\"ToastGeneric\"><text>{}</text><text>{}</text></binding></visual><audio src=\"ms-winsoundevent:Notification.Default\"/></toast>",
        escape_xml(&launch),
        escape_xml(title),
        escape_xml(body),
    );
    let document = XmlDocument::new().map_err(|_| ())?;
    document.LoadXml(&HSTRING::from(xml)).map_err(|_| ())?;
    let toast = ToastNotification::CreateToastNotification(&document).map_err(|_| ())?;
    toast
        .SetTag(&HSTRING::from(notification_id))
        .map_err(|_| ())?;
    toast
        .SetGroup(&HSTRING::from(WINDOWS_NOTIFICATION_GROUP))
        .map_err(|_| ())?;
    let notifier =
        ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(WINDOWS_APP_ID))
            .map_err(|_| ())?;
    notifier.Show(&toast).map_err(|_| ())
}

#[cfg(windows)]
fn escape_xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

#[cfg(target_os = "linux")]
async fn display_notification(
    app: &AppHandle,
    _notification_id: &str,
    title: &str,
    body: &str,
) -> Result<(), ()> {
    let handle = notify_rust::Notification::new()
        .appname("Alook")
        .summary(title)
        .body(body)
        .action("default", "Open")
        .show()
        .map_err(|_| ())?;
    let app = app.clone();
    std::thread::spawn(move || {
        handle.wait_for_action(|action| {
            if action == "default" {
                crate::commands::show_main_window(&app);
            }
        });
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn startup_url_removes_credentials_query_and_fragment() {
        for input in [
            "https://user:secret@example.com:8443/c/invite?token=secret#private",
            "https://user@example.com:8443/c/invite?token=secret#private",
            "https://:secret@example.com:8443/c/invite?token=secret#private",
        ] {
            assert_eq!(
                sanitized_startup_url(url::Url::parse(input).unwrap()),
                Ok("https://example.com:8443/c/invite".into())
            );
        }
    }

    #[test]
    fn startup_url_preserves_actual_origin_port_and_path() {
        for (input, expected) in [
            (
                "alook-recovery://localhost/bootstrap?private=value#fragment",
                "alook-recovery://localhost/bootstrap",
            ),
            (
                "http://localhost:5173/sign-in?redirect=%2Fc#fragment",
                "http://localhost:5173/sign-in",
            ),
            ("about:blank?private=value#fragment", "about:blank"),
            (
                "file:///actual/bootstrap.html",
                "file:///actual/bootstrap.html",
            ),
        ] {
            assert_eq!(
                sanitized_startup_url(url::Url::parse(input).unwrap()),
                Ok(expected.into())
            );
        }
    }

    #[test]
    fn notification_diagnostics_require_the_exact_qa_identity_and_switch() {
        let qa = "ai.alook.desktop.qa.madox.notification208";
        assert!(notification_diagnostic_identity_allowed(qa, Some("208")));
        for switch in [Some("208 "), Some("0208"), Some("1"), Some(""), None] {
            assert!(!notification_diagnostic_identity_allowed(qa, switch));
        }
        for identifier in [
            "ai.alook.desktop",
            "ai.alook.desktop.qa.madox.notification208.extra",
            "",
        ] {
            assert!(!notification_diagnostic_identity_allowed(
                identifier,
                Some("208")
            ));
        }
    }

    fn target(message_id: &str) -> NotificationTarget {
        NotificationTarget::Server {
            server_id: "server_1".into(),
            channel_id: "channel_1".into(),
            message_id: message_id.into(),
            seq: 1,
        }
    }

    fn candidate(viewer: &str, message: &str) -> NotificationCandidate {
        NotificationCandidate {
            viewer_user_id: viewer.into(),
            title: "Ada".into(),
            body: "Hello".into(),
            target: target(message),
        }
    }

    fn candidate_in(
        viewer: &str,
        server_id: &str,
        channel_id: &str,
        message_id: &str,
    ) -> NotificationCandidate {
        NotificationCandidate {
            viewer_user_id: viewer.into(),
            title: "Ada".into(),
            body: "Hello".into(),
            target: NotificationTarget::Server {
                server_id: server_id.into(),
                channel_id: channel_id.into(),
                message_id: message_id.into(),
                seq: 1,
            },
        }
    }

    #[test]
    fn presentation_identity_uses_only_the_original_bounded_record_including_dismissed_items() {
        let mut record = NotificationRecord::new();
        let id = record.claim(&candidate("viewer_1", "message_1")).unwrap();
        record.complete_dismissals(&[id.clone()]);
        assert_eq!(
            record.presentation_identity(&id),
            Some(("viewer_1".into(), "channel_1".into()))
        );
        assert_eq!(record.presentation_identity("unknown"), None);
    }

    #[cfg(target_os = "macos")]
    fn presentation_test_completion(
    ) -> (Arc<PresentationCompletion>, std::sync::mpsc::Receiver<u64>) {
        let (sender, receiver) = std::sync::mpsc::channel();
        let callback = block2::RcBlock::new(
            move |options: objc2_user_notifications::UNNotificationPresentationOptions| {
                sender.send(options.bits() as u64).unwrap();
            },
        );
        (
            PresentationCompletion::new(SendablePresentationCompletion(callback)),
            receiver,
        )
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn presentation_first_completion_wins_and_cancels_the_deadline() {
        let (decision, receiver) = presentation_test_completion();
        assert!(decision.finish(true));
        assert!(!decision.finish(false));
        assert_eq!(receiver.recv().unwrap(), 0);
        assert!(receiver
            .recv_timeout(std::time::Duration::from_millis(600))
            .is_err());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn presentation_deadline_shows_normally_and_late_true_cannot_consume_it() {
        let (decision, receiver) = presentation_test_completion();
        assert_eq!(
            receiver
                .recv_timeout(std::time::Duration::from_secs(2))
                .unwrap(),
            macos_presentation_options(false).bits() as u64
        );
        assert!(!decision.finish(true));
        assert!(receiver.try_recv().is_err());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn presentation_racing_outcomes_take_the_completion_once() {
        let (decision, receiver) = presentation_test_completion();
        let fallback = decision.clone();
        let thread = std::thread::spawn(move || fallback.finish(false));
        let authorized = decision.finish(true);
        let normal = thread.join().unwrap();
        assert_ne!(authorized, normal);
        assert_eq!(
            receiver.recv().unwrap(),
            macos_presentation_options(authorized).bits() as u64
        );
        assert!(receiver.try_recv().is_err());
    }

    #[test]
    fn deterministic_ids_are_stable_scoped_and_uuid_shaped() {
        let first = deterministic_notification_id("viewer_1", "message_1");
        assert_eq!(
            first,
            deterministic_notification_id("viewer_1", "message_1")
        );
        assert_ne!(
            first,
            deterministic_notification_id("viewer_2", "message_1")
        );
        assert_ne!(
            first,
            deterministic_notification_id("viewer_1", "message_2")
        );
        assert!(valid_notification_id(&first));
        assert_eq!(&first[14..15], "5");
    }

    #[test]
    fn claim_deduplicates_and_bounds_persisted_history() {
        let mut record = NotificationRecord::new();
        let id = record.claim(&candidate("viewer_1", "message_1")).unwrap();
        assert!(record.claim(&candidate("viewer_1", "message_1")).is_none());
        assert!(record.claim(&candidate("viewer_2", "message_1")).is_some());
        record.rollback(&id);
        assert!(record.claim(&candidate("viewer_1", "message_1")).is_some());
        for index in 2..=300 {
            assert!(record
                .claim(&candidate("viewer_1", &format!("message_{index}")))
                .is_some());
        }
        assert_eq!(record.recent.len(), MAX_RECENT);
        assert_eq!(record.recent.last().unwrap().message_id, "message_300");
    }

    #[test]
    fn activation_is_one_shot_until_an_exact_retry_and_restorable() {
        let mut record = NotificationRecord::new();
        let id = record.claim(&candidate("viewer_1", "message_1")).unwrap();
        assert_eq!(record.activate(&id).unwrap().target, target("message_1"));
        assert!(record.activate(&id).is_none());
        assert!(!record.retry_activation("00000000-0000-0000-0000-000000000000"));
        assert!(record.retry_activation(&id));
        assert!(!record.retry_activation(&id));
        let mut restored =
            NotificationRecord::restore(serde_json::to_value(record).unwrap()).unwrap();
        assert!(!restored.recent[0].activated);
        assert_eq!(restored.activate(&id).unwrap().target, target("message_1"));
        assert!(restored.recent[0].activated);
    }

    #[test]
    fn conversation_dismissal_is_exact_across_messages_conversations_and_accounts() {
        let mut record = NotificationRecord::new();
        let same_first = record
            .claim(&candidate_in(
                "viewer_1",
                "server_1",
                "channel_1",
                "message_1",
            ))
            .unwrap();
        let same_second = record
            .claim(&candidate_in(
                "viewer_1",
                "server_1",
                "channel_1",
                "message_2",
            ))
            .unwrap();
        let other_channel = record
            .claim(&candidate_in(
                "viewer_1",
                "server_1",
                "channel_2",
                "message_3",
            ))
            .unwrap();
        let other_viewer = record
            .claim(&candidate_in(
                "viewer_2",
                "server_1",
                "channel_1",
                "message_4",
            ))
            .unwrap();
        let conversation = NotificationConversation::Server {
            server_id: "server_1".to_string(),
            channel_id: "channel_1".to_string(),
        };

        assert_eq!(
            record.notification_ids("viewer_1", &conversation),
            vec![same_first.clone(), same_second.clone()],
        );
        record.complete_dismissals(&[same_first.clone(), same_second.clone()]);
        assert_eq!(
            record.notification_ids("viewer_1", &conversation),
            Vec::<String>::new()
        );
        assert!(record
            .claim(&candidate_in(
                "viewer_1",
                "server_1",
                "channel_1",
                "message_1"
            ))
            .is_none());
        assert!(record
            .recent
            .iter()
            .any(|item| item.notification_id == other_channel));
        assert!(record
            .recent
            .iter()
            .any(|item| item.notification_id == other_viewer));

        let restored = NotificationRecord::restore(serde_json::to_value(record).unwrap()).unwrap();
        assert_eq!(
            restored.notification_ids("viewer_1", &conversation),
            Vec::<String>::new()
        );
        assert!(restored
            .recent
            .iter()
            .any(|item| item.notification_id == same_first));
        assert!(restored
            .recent
            .iter()
            .any(|item| item.notification_id == same_second));
    }

    #[test]
    fn old_records_without_a_dismissed_field_restore_as_delivered() {
        let id = deterministic_notification_id("viewer_1", "message_1");
        let record = NotificationRecord::restore(serde_json::json!({
            "version": 1,
            "recent": [{
                "notificationId": id,
                "viewerUserId": "viewer_1",
                "messageId": "message_1",
                "target": {
                    "kind": "server",
                    "serverId": "server_1",
                    "channelId": "channel_1",
                    "messageId": "message_1",
                    "seq": 1
                },
                "activated": false
            }]
        }))
        .unwrap();
        assert_eq!(
            record.notification_ids(
                "viewer_1",
                &NotificationConversation::Server {
                    server_id: "server_1".into(),
                    channel_id: "channel_1".into(),
                },
            ),
            vec![id],
        );
    }

    #[test]
    fn restore_rejects_unknown_or_malformed_state() {
        assert!(NotificationRecord::restore(serde_json::json!({
            "version": 1,
            "recent": [],
            "extra": true
        }))
        .is_err());
        assert!(NotificationRecord::restore(serde_json::json!({
            "version": 2,
            "recent": []
        }))
        .is_err());
    }

    #[test]
    fn activation_url_parser_is_exact() {
        let id = deterministic_notification_id("viewer_1", "message_1");
        let valid = url::Url::parse(&format!(
            "{ACTIVATION_SCHEME}://{ACTIVATION_HOST}{ACTIVATION_PATH}?id={id}"
        ))
        .unwrap();
        assert_eq!(activation_id_from_url(&valid), Some(id.clone()));
        for raw in [
            format!("https://notification/open?id={id}"),
            format!("{ACTIVATION_SCHEME}://evil/open?id={id}"),
            format!("{ACTIVATION_SCHEME}://{ACTIVATION_HOST}/elsewhere?id={id}"),
            format!("{ACTIVATION_SCHEME}://{ACTIVATION_HOST}{ACTIVATION_PATH}?id={id}&next=https://evil.test"),
        ] {
            assert!(activation_id_from_url(&url::Url::parse(&raw).unwrap()).is_none());
        }
    }

    #[test]
    fn macos_completion_results_fail_closed_before_rollback() {
        assert_eq!(macos_authorization_result(true, false), Ok(()));
        assert_eq!(macos_authorization_result(false, false), Err(()));
        assert_eq!(macos_authorization_result(true, true), Err(()));
        assert_eq!(macos_add_result(false), Ok(()));
        assert_eq!(macos_add_result(true), Err(()));

        let mut record = NotificationRecord::new();
        let original = candidate("viewer_1", "message_1");
        let id = record.claim(&original).unwrap();
        assert!(macos_add_result(true).is_err());
        record.rollback(&id);
        assert_eq!(record.claim(&original), Some(id));
    }
}
