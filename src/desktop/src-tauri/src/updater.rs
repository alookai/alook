use serde::Serialize;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use std::time::Duration;
use tauri::{
    menu::{Menu, MenuItem, MenuItemBuilder, PredefinedMenuItem},
    AppHandle, Emitter,
};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_updater::UpdaterExt;

pub const CHECK_FOR_UPDATES_MENU_ID: &str = "check-for-updates";
const UPDATE_CHECK_TIMEOUT: Duration = Duration::from_secs(15);
const UPDATE_DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const AUTO_CHECK_INITIAL_DELAY: Duration = Duration::from_secs(30);
const AUTO_CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
const DEFAULT_UPDATE_LABEL: &str = "Check for Updates…";

#[cfg(debug_assertions)]
const SIMULATE_AVAILABLE_MENU_ID: &str = "simulate-update-available";
#[cfg(debug_assertions)]
const SIMULATE_PROGRESS_MENU_ID: &str = "simulate-update-progress";
#[cfg(debug_assertions)]
const SIMULATE_COMPLETE_MENU_ID: &str = "simulate-update-complete";
#[cfg(debug_assertions)]
const SIMULATE_FAILURE_MENU_ID: &str = "simulate-update-failure";

static UPDATE_AVAILABLE_VERSION: Mutex<Option<String>> = Mutex::new(None);
static UPDATE_IN_PROGRESS: AtomicBool = AtomicBool::new(false);
static UPDATE_MENU_ITEMS: Mutex<Vec<MenuItem<tauri::Wry>>> = Mutex::new(Vec::new());

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CheckSource {
    Manual,
    Automatic,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CheckPresentation {
    Silent,
    UpToDate,
    PromptAvailable,
    NotifyAvailable,
    ShowError,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CheckOutcome {
    Current,
    Available,
    Failed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum UpdateMenuAction {
    Check,
    #[cfg(debug_assertions)]
    SimulateAvailable,
    #[cfg(debug_assertions)]
    SimulateProgress,
    #[cfg(debug_assertions)]
    SimulateComplete,
    #[cfg(debug_assertions)]
    SimulateFailure,
}

#[derive(Serialize, Clone)]
struct UpdateProgress {
    percent: f64,
    downloaded: u64,
    total: Option<u64>,
}

struct UpdateInProgressGuard<'a> {
    flag: &'a AtomicBool,
}

impl<'a> UpdateInProgressGuard<'a> {
    fn acquire(flag: &'a AtomicBool) -> Option<Self> {
        flag.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .ok()
            .map(|_| Self { flag })
    }
}

impl Drop for UpdateInProgressGuard<'_> {
    fn drop(&mut self) {
        self.flag.store(false, Ordering::SeqCst);
    }
}

fn presentation_for(
    source: CheckSource,
    outcome: CheckOutcome,
    already_notified: bool,
) -> CheckPresentation {
    match (source, outcome, already_notified) {
        (CheckSource::Manual, CheckOutcome::Current, _) => CheckPresentation::UpToDate,
        (CheckSource::Manual, CheckOutcome::Available, _) => CheckPresentation::PromptAvailable,
        (CheckSource::Manual, CheckOutcome::Failed, _) => CheckPresentation::ShowError,
        (CheckSource::Automatic, CheckOutcome::Available, false) => {
            CheckPresentation::NotifyAvailable
        }
        _ => CheckPresentation::Silent,
    }
}

fn menu_action(id: &str) -> Option<UpdateMenuAction> {
    match id {
        CHECK_FOR_UPDATES_MENU_ID => Some(UpdateMenuAction::Check),
        #[cfg(debug_assertions)]
        SIMULATE_AVAILABLE_MENU_ID => Some(UpdateMenuAction::SimulateAvailable),
        #[cfg(debug_assertions)]
        SIMULATE_PROGRESS_MENU_ID => Some(UpdateMenuAction::SimulateProgress),
        #[cfg(debug_assertions)]
        SIMULATE_COMPLETE_MENU_ID => Some(UpdateMenuAction::SimulateComplete),
        #[cfg(debug_assertions)]
        SIMULATE_FAILURE_MENU_ID => Some(UpdateMenuAction::SimulateFailure),
        _ => None,
    }
}

fn normalized_progress(downloaded: u64, total: Option<u64>) -> f64 {
    total
        .filter(|value| *value > 0)
        .map(|value| (downloaded as f64 / value as f64) * 100.0)
        .unwrap_or(0.0)
        .clamp(0.0, 100.0)
}

fn update_label(version: &str) -> String {
    format!("Update to v{version}…")
}

fn register_update_menu_item(item: MenuItem<tauri::Wry>) {
    UPDATE_MENU_ITEMS
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .push(item);
}

fn set_update_menu(label: &str, enabled: bool) {
    let items = UPDATE_MENU_ITEMS
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    for item in items.iter() {
        let _ = item.set_text(label);
        let _ = item.set_enabled(enabled);
    }
}

fn set_update_available(version: &str) {
    set_update_menu(&update_label(version), true);
}

fn mark_notified(version: &str) -> bool {
    let mut notified = UPDATE_AVAILABLE_VERSION
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let already_notified = notified.as_deref() == Some(version);
    if !already_notified {
        *notified = Some(version.to_string());
    }
    already_notified
}

pub fn build_app_menu(handle: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = Menu::default(handle)?;

    #[cfg(target_os = "macos")]
    if let Some(app_menu) = menu
        .items()?
        .first()
        .and_then(|item| item.as_submenu())
        .cloned()
    {
        let check_item = MenuItemBuilder::with_id(CHECK_FOR_UPDATES_MENU_ID, DEFAULT_UPDATE_LABEL)
            .build(handle)?;
        let separator = PredefinedMenuItem::separator(handle)?;
        app_menu.insert(&check_item, 2)?;
        app_menu.insert(&separator, 3)?;
        register_update_menu_item(check_item);

        #[cfg(debug_assertions)]
        {
            use tauri::menu::SubmenuBuilder;
            let simulator = SubmenuBuilder::new(handle, "Update Simulator")
                .text(SIMULATE_AVAILABLE_MENU_ID, "Update Available")
                .text(SIMULATE_PROGRESS_MENU_ID, "Downloading 42%")
                .text(SIMULATE_COMPLETE_MENU_ID, "Ready to Restart")
                .text(SIMULATE_FAILURE_MENU_ID, "Update Failed")
                .build()?;
            app_menu.insert(&simulator, 4)?;
        }
    }

    Ok(menu)
}

pub fn register_tray_update_item(item: MenuItem<tauri::Wry>) {
    register_update_menu_item(item);
}

pub fn handle_menu_event(handle: &AppHandle, id: &str) -> bool {
    let Some(action) = menu_action(id) else {
        return false;
    };

    match action {
        UpdateMenuAction::Check => {
            let app = handle.clone();
            tauri::async_runtime::spawn(async move {
                install_update(&app).await;
            });
        }
        #[cfg(debug_assertions)]
        UpdateMenuAction::SimulateAvailable => simulate_available(handle),
        #[cfg(debug_assertions)]
        UpdateMenuAction::SimulateProgress => simulate_progress(handle),
        #[cfg(debug_assertions)]
        UpdateMenuAction::SimulateComplete => simulate_complete(handle),
        #[cfg(debug_assertions)]
        UpdateMenuAction::SimulateFailure => simulate_failure(handle),
    }
    true
}

pub async fn install_update(handle: &AppHandle) {
    let Some(update_guard) = UpdateInProgressGuard::acquire(&UPDATE_IN_PROGRESS) else {
        handle
            .dialog()
            .message("An update is already in progress.")
            .title("Alook")
            .buttons(MessageDialogButtons::OkCustom("OK".into()))
            .show(|_| {});
        return;
    };

    set_update_menu("Checking for Updates…", false);
    let updater = match handle
        .updater_builder()
        .timeout(UPDATE_CHECK_TIMEOUT)
        .build()
    {
        Ok(updater) => updater,
        Err(error) => {
            set_update_menu(DEFAULT_UPDATE_LABEL, true);
            show_check_error(handle, &error.to_string());
            return;
        }
    };

    match updater.check().await {
        Ok(Some(mut update)) => {
            update.timeout = Some(UPDATE_DOWNLOAD_TIMEOUT);
            let version = update.version.clone();
            let notes = update.body.clone().unwrap_or_default();
            set_update_available(&version);
            let message = if notes.is_empty() {
                format!("Alook {version} is available. Download and install it now?")
            } else {
                format!("Alook {version} is available.\n\n{notes}\n\nDownload and install it now?")
            };
            let app = handle.clone();
            handle
                .dialog()
                .message(&message)
                .title("Update Available")
                .buttons(MessageDialogButtons::OkCancelCustom(
                    "Update Alook".into(),
                    "Later".into(),
                ))
                .show(move |confirmed| {
                    if confirmed {
                        tauri::async_runtime::spawn(async move {
                            download_and_install(app, update, update_guard).await;
                        });
                    }
                });
        }
        Ok(None) => {
            set_update_menu(DEFAULT_UPDATE_LABEL, true);
            if presentation_for(CheckSource::Manual, CheckOutcome::Current, false)
                == CheckPresentation::UpToDate
            {
                handle
                    .dialog()
                    .message(format!(
                        "Alook {} is the latest version.",
                        handle.package_info().version
                    ))
                    .title("Alook Is Up to Date")
                    .buttons(MessageDialogButtons::OkCustom("Done".into()))
                    .show(|_| {});
            }
        }
        Err(error) => {
            set_update_menu(DEFAULT_UPDATE_LABEL, true);
            if presentation_for(CheckSource::Manual, CheckOutcome::Failed, false)
                == CheckPresentation::ShowError
            {
                show_check_error(handle, &error.to_string());
            }
        }
    }
}

fn show_check_error(handle: &AppHandle, error: &str) {
    handle
        .dialog()
        .message(format!(
            "Alook couldn’t check for updates. Check your connection and try again.\n\n{error}"
        ))
        .title("Update Check Failed")
        .buttons(MessageDialogButtons::OkCustom("Close".into()))
        .show(|_| {});
}

async fn download_and_install(
    handle: AppHandle,
    update: tauri_plugin_updater::Update,
    update_guard: UpdateInProgressGuard<'static>,
) {
    let version = update.version.clone();
    set_update_menu("Downloading Update… 0%", false);
    let _ = handle
        .notification()
        .builder()
        .title("Alook")
        .body(format!("Downloading Alook {version}…"))
        .show();

    let app = handle.clone();
    let mut downloaded = 0_u64;
    let mut displayed_bucket = 0_u8;
    let result = update
        .download_and_install(
            move |chunk_size, total| {
                downloaded += chunk_size as u64;
                let percent = normalized_progress(downloaded, total);
                let bucket = (percent / 5.0).floor() as u8;
                if bucket > displayed_bucket {
                    displayed_bucket = bucket;
                    set_update_menu(&format!("Downloading Update… {:.0}%", percent), false);
                }
                let _ = app.emit(
                    "update://progress",
                    UpdateProgress {
                        percent,
                        downloaded,
                        total,
                    },
                );
            },
            || {},
        )
        .await;

    match result {
        Ok(()) => {
            set_update_menu("Restart Alook to Finish Update", false);
            let app = handle.clone();
            handle
                .dialog()
                .message(format!(
                    "Alook {version} is installed. Restart to finish the update."
                ))
                .title("Ready to Restart")
                .buttons(MessageDialogButtons::OkCancelCustom(
                    "Restart Alook".into(),
                    "Later".into(),
                ))
                .show(move |restart| {
                    if restart {
                        app.restart();
                    }
                    drop(update_guard);
                });
        }
        Err(error) => {
            set_update_available(&version);
            handle
                .dialog()
                .message(format!(
                    "Alook couldn’t install the update. Try again from the Alook menu.\n\n{error}"
                ))
                .title("Update Failed")
                .buttons(MessageDialogButtons::OkCustom("Close".into()))
                .show(|_| {});
        }
    }
}

pub fn auto_check_updates(handle: AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(AUTO_CHECK_INITIAL_DELAY);
        loop {
            let app = handle.clone();
            let found = tauri::async_runtime::block_on(async {
                let updater = app
                    .updater_builder()
                    .timeout(UPDATE_CHECK_TIMEOUT)
                    .build()
                    .ok()?;
                let update = updater.check().await.ok()??;
                Some(update.version.clone())
            });

            if let Some(version) = found {
                set_update_available(&version);
                let already_notified = mark_notified(&version);
                if presentation_for(
                    CheckSource::Automatic,
                    CheckOutcome::Available,
                    already_notified,
                ) == CheckPresentation::NotifyAvailable
                {
                    let _ = handle
                        .notification()
                        .builder()
                        .title("Alook Update Available")
                        .body(format!(
                            "Alook {version} is ready. Open the Alook menu to update."
                        ))
                        .show();
                }
            }

            std::thread::sleep(AUTO_CHECK_INTERVAL);
        }
    });
}

#[cfg(debug_assertions)]
fn simulate_available(handle: &AppHandle) {
    set_update_available("9.9.9-test");
    handle
        .dialog()
        .message("Alook 9.9.9-test is available.\n\nThis is a local UI simulation. No update will be downloaded.\n\nDownload and install it now?")
        .title("Update Available")
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Update Alook".into(),
            "Later".into(),
        ))
        .show(|_| {});
}

#[cfg(debug_assertions)]
fn simulate_progress(handle: &AppHandle) {
    set_update_menu("Downloading Update… 42%", false);
    handle
        .dialog()
        .message("Downloading Alook 9.9.9-test\n\n42% complete\n\nThis is a local UI simulation.")
        .title("Downloading Update")
        .buttons(MessageDialogButtons::OkCustom("Done".into()))
        .show(|_| {});
    set_update_menu(DEFAULT_UPDATE_LABEL, true);
}

#[cfg(debug_assertions)]
fn simulate_complete(handle: &AppHandle) {
    set_update_menu("Restart Alook to Finish Update", false);
    handle
        .dialog()
        .message("Alook 9.9.9-test is installed. Restart to finish the update.\n\nThis is a local UI simulation; Alook will not restart.")
        .title("Ready to Restart")
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Restart Alook".into(),
            "Later".into(),
        ))
        .show(|_| {});
    set_update_menu(DEFAULT_UPDATE_LABEL, true);
}

#[cfg(debug_assertions)]
fn simulate_failure(handle: &AppHandle) {
    set_update_menu(DEFAULT_UPDATE_LABEL, true);
    handle
        .dialog()
        .message("Alook couldn’t install the update. Try again from the Alook menu.\n\nSimulated network failure")
        .title("Update Failed")
        .buttons(MessageDialogButtons::OkCustom("Close".into()))
        .show(|_| {});
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manual_checks_present_every_outcome() {
        assert_eq!(
            presentation_for(CheckSource::Manual, CheckOutcome::Current, false),
            CheckPresentation::UpToDate
        );
        assert_eq!(
            presentation_for(CheckSource::Manual, CheckOutcome::Available, false),
            CheckPresentation::PromptAvailable
        );
        assert_eq!(
            presentation_for(CheckSource::Manual, CheckOutcome::Failed, false),
            CheckPresentation::ShowError
        );
    }

    #[test]
    fn automatic_checks_are_silent_except_for_a_new_version() {
        assert_eq!(
            presentation_for(CheckSource::Automatic, CheckOutcome::Current, false),
            CheckPresentation::Silent
        );
        assert_eq!(
            presentation_for(CheckSource::Automatic, CheckOutcome::Failed, false),
            CheckPresentation::Silent
        );
        assert_eq!(
            presentation_for(CheckSource::Automatic, CheckOutcome::Available, false),
            CheckPresentation::NotifyAvailable
        );
        assert_eq!(
            presentation_for(CheckSource::Automatic, CheckOutcome::Available, true),
            CheckPresentation::Silent
        );
    }

    #[test]
    fn update_lock_releases_on_every_scope_exit() {
        let flag = AtomicBool::new(false);
        let guard = UpdateInProgressGuard::acquire(&flag).unwrap();
        assert!(flag.load(Ordering::SeqCst));
        assert!(UpdateInProgressGuard::acquire(&flag).is_none());
        drop(guard);
        assert!(!flag.load(Ordering::SeqCst));
        assert!(UpdateInProgressGuard::acquire(&flag).is_some());
    }

    #[test]
    fn progress_is_stable_for_unknown_zero_and_oversized_totals() {
        assert_eq!(normalized_progress(10, None), 0.0);
        assert_eq!(normalized_progress(10, Some(0)), 0.0);
        assert_eq!(normalized_progress(50, Some(100)), 50.0);
        assert_eq!(normalized_progress(120, Some(100)), 100.0);
    }

    #[test]
    fn menu_routes_share_the_check_action() {
        assert_eq!(
            menu_action(CHECK_FOR_UPDATES_MENU_ID),
            Some(UpdateMenuAction::Check)
        );
        assert_eq!(menu_action("update"), None);
        assert_eq!(menu_action("unknown"), None);
    }

    #[test]
    fn updater_network_operations_have_explicit_deadlines() {
        let source = include_str!("updater.rs");
        assert_eq!(UPDATE_CHECK_TIMEOUT, Duration::from_secs(15));
        assert_eq!(UPDATE_DOWNLOAD_TIMEOUT, Duration::from_secs(10 * 60));
        assert_eq!(AUTO_CHECK_INTERVAL, Duration::from_secs(6 * 60 * 60));
        assert!(source.matches(".timeout(UPDATE_CHECK_TIMEOUT)").count() >= 2);
        assert!(source.contains("update.timeout = Some(UPDATE_DOWNLOAD_TIMEOUT)"));
    }

    #[test]
    fn labels_name_the_action_and_target_version() {
        assert_eq!(DEFAULT_UPDATE_LABEL, "Check for Updates…");
        assert_eq!(update_label("1.2.3"), "Update to v1.2.3…");
    }

    #[test]
    fn recovery_copy_names_the_next_user_action() {
        let source = include_str!("updater.rs");
        assert!(source.contains("Check your connection and try again"));
        assert!(source.contains("Try again from the Alook menu"));
        assert!(source.contains("Restart Alook"));
        assert!(source.contains("Later"));
    }

    #[test]
    fn app_menu_and_debug_simulator_are_declared_separately() {
        let source = include_str!("updater.rs");
        assert!(source.contains("app_menu.insert(&check_item, 2)"));
        assert!(source.contains("#[cfg(debug_assertions)]\n        {"));
        assert!(source.contains("Update Simulator"));
    }
}
