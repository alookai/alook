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

impl NotificationTarget {
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
    guard(&window)?;
    if !candidate.valid() {
        return Err("notification_invalid");
    }
    let Some(notification_id) = state.transact(|record| Ok(record.claim(&candidate)))? else {
        return Ok(());
    };
    if display_notification(
        window.app_handle(),
        &notification_id,
        &candidate.title,
        &candidate.body,
    )
    .await
    .is_err()
    {
        state.transact(|record| {
            record.rollback(&notification_id);
            Ok(())
        })?;
        return Err("notification_unavailable");
    }
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

#[cfg(target_os = "macos")]
async fn display_notification(
    _app: &AppHandle,
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
    wait_for_macos_completion(authorization).await?;

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
        let completion = RcBlock::new(move |error: *mut NSError| {
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
                _notification: &UNNotification,
                completion: &DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
            ) {
                completion.call((UNNotificationPresentationOptions::Banner
                    | UNNotificationPresentationOptions::List
                    | UNNotificationPresentationOptions::Sound,));
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
    let notifier =
        ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from("ai.alook.desktop"))
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
    fn activation_is_one_shot_and_restorable() {
        let mut record = NotificationRecord::new();
        let id = record.claim(&candidate("viewer_1", "message_1")).unwrap();
        assert_eq!(record.activate(&id).unwrap().target, target("message_1"));
        assert!(record.activate(&id).is_none());
        let restored = NotificationRecord::restore(serde_json::to_value(record).unwrap()).unwrap();
        assert!(restored.recent[0].activated);
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
