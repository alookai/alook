use serde::Serialize;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use std::time::Duration;
use tauri::{
    menu::{Menu, MenuItem, MenuItemBuilder, PredefinedMenuItem, HELP_SUBMENU_ID},
    AppHandle, Emitter, Manager,
};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_updater::UpdaterExt;

pub const CHECK_FOR_UPDATES_MENU_ID: &str = "check-for-updates";
const GITHUB_REPOSITORY_MENU_ID: &str = "github-repository";
const GITHUB_REPOSITORY_URL: &str = "https://github.com/alookai/alook";
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

static LAST_AUTOMATIC_PROMPT_VERSION: Mutex<Option<String>> = Mutex::new(None);
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
    ShowError,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CheckOutcome {
    Current,
    Available,
    Failed,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum AutomaticOfferDisposition {
    RefreshMenu,
    Blocked,
    Published(UpdatePrompt),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum UpdatePromptResponse {
    Update,
    Later,
}

impl From<bool> for UpdatePromptResponse {
    fn from(update: bool) -> Self {
        if update {
            Self::Update
        } else {
            Self::Later
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum UpdateMenuAction {
    Check,
    OpenRepository,
    #[cfg(debug_assertions)]
    SimulateAvailable,
    #[cfg(debug_assertions)]
    SimulateProgress,
    #[cfg(debug_assertions)]
    SimulateComplete,
    #[cfg(debug_assertions)]
    SimulateFailure,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum UpdateMenuLocation {
    Application,
    Help,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct UpdateMenuLayout {
    location: UpdateMenuLocation,
    repository_position: usize,
    check_position: usize,
    separator_position: usize,
    simulator_position: usize,
}

#[derive(Serialize, Clone)]
struct UpdateProgress {
    percent: f64,
    downloaded: u64,
    total: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct UpdatePrompt {
    current_version: String,
    available_version: String,
}

struct PendingUpdate {
    prompt: UpdatePrompt,
    update: Option<tauri_plugin_updater::Update>,
    update_guard: Option<UpdateInProgressGuard<'static>>,
}

#[derive(Default)]
pub struct UpdatePromptState {
    pending: Mutex<Option<PendingUpdate>>,
}

impl UpdatePromptState {
    fn replace(&self, pending: PendingUpdate) -> UpdatePrompt {
        let prompt = pending.prompt.clone();
        *self
            .pending
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = Some(pending);
        prompt
    }

    #[cfg(test)]
    fn prompt(&self) -> Option<UpdatePrompt> {
        self.pending
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .as_ref()
            .map(|pending| pending.prompt.clone())
    }

    fn prepare_automatic(
        &self,
        mut pending_update: PendingUpdate,
        update_in_progress: &'static AtomicBool,
        already_prompted: bool,
    ) -> AutomaticOfferDisposition {
        if presentation_for(
            CheckSource::Automatic,
            CheckOutcome::Available,
            already_prompted,
        ) != CheckPresentation::PromptAvailable
        {
            return AutomaticOfferDisposition::RefreshMenu;
        }

        let Some(update_guard) = UpdateInProgressGuard::acquire(update_in_progress) else {
            return AutomaticOfferDisposition::Blocked;
        };
        let mut pending = self
            .pending
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if pending.is_some() {
            return AutomaticOfferDisposition::Blocked;
        }

        let prompt = pending_update.prompt.clone();
        pending_update.update_guard = Some(update_guard);
        *pending = Some(pending_update);
        AutomaticOfferDisposition::Published(prompt)
    }

    fn take_matching(&self, version: &str) -> Result<PendingUpdate, String> {
        let mut pending = self
            .pending
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        match pending.as_ref() {
            Some(value) if value.prompt.available_version == version => Ok(pending.take().unwrap()),
            Some(_) => Err("update prompt version is stale".to_string()),
            None => Err("update prompt is no longer available".to_string()),
        }
    }

    fn restore_if_empty(&self, pending_update: PendingUpdate) {
        let mut pending = self
            .pending
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if pending.is_none() {
            *pending = Some(pending_update);
        }
    }

    fn consume_response(
        &self,
        version: &str,
        response: UpdatePromptResponse,
    ) -> Result<Option<PendingUpdate>, String> {
        let pending_update = self.take_matching(version)?;
        if response == UpdatePromptResponse::Later || pending_update.update.is_none() {
            Ok(None)
        } else {
            Ok(Some(pending_update))
        }
    }
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
            CheckPresentation::PromptAvailable
        }
        _ => CheckPresentation::Silent,
    }
}

fn update_prompt(current_version: &str, available_version: &str) -> UpdatePrompt {
    UpdatePrompt {
        current_version: current_version.to_string(),
        available_version: available_version.to_string(),
    }
}

fn update_prompt_message(prompt: &UpdatePrompt) -> String {
    format!(
        "Current version: {}\nNew version: {}",
        prompt.current_version, prompt.available_version
    )
}

fn was_automatic_version_prompted(last_prompted: &mut Option<String>, version: &str) -> bool {
    let already_prompted = last_prompted.as_deref() == Some(version);
    if !already_prompted {
        *last_prompted = Some(version.to_string());
    }
    already_prompted
}

fn menu_action(id: &str) -> Option<UpdateMenuAction> {
    match id {
        CHECK_FOR_UPDATES_MENU_ID => Some(UpdateMenuAction::Check),
        GITHUB_REPOSITORY_MENU_ID => Some(UpdateMenuAction::OpenRepository),
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

fn update_menu_layout(target_os: &str) -> UpdateMenuLayout {
    if target_os == "macos" {
        UpdateMenuLayout {
            location: UpdateMenuLocation::Application,
            repository_position: 1,
            check_position: 3,
            separator_position: 4,
            simulator_position: 5,
        }
    } else {
        UpdateMenuLayout {
            location: UpdateMenuLocation::Help,
            repository_position: 1,
            check_position: 0,
            separator_position: 1,
            simulator_position: 1,
        }
    }
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

fn mark_automatic_prompted(version: &str) -> bool {
    let mut last_prompted = LAST_AUTOMATIC_PROMPT_VERSION
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    was_automatic_version_prompted(&mut last_prompted, version)
}

fn automatic_version_prompted(version: &str) -> bool {
    LAST_AUTOMATIC_PROMPT_VERSION
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .as_deref()
        == Some(version)
}

pub fn build_app_menu(handle: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = Menu::default(handle)?;
    let layout = update_menu_layout(std::env::consts::OS);
    let target_menu = match layout.location {
        UpdateMenuLocation::Application => menu
            .items()?
            .first()
            .and_then(|item| item.as_submenu())
            .cloned(),
        UpdateMenuLocation::Help => menu
            .get(HELP_SUBMENU_ID)
            .and_then(|item| item.as_submenu().cloned()),
    };

    if let Some(target_menu) = target_menu {
        let repository_item =
            MenuItemBuilder::with_id(GITHUB_REPOSITORY_MENU_ID, "GitHub Repository…")
                .build(handle)?;
        target_menu.insert(&repository_item, layout.repository_position)?;
        let check_item = MenuItemBuilder::with_id(CHECK_FOR_UPDATES_MENU_ID, DEFAULT_UPDATE_LABEL)
            .build(handle)?;
        let separator = PredefinedMenuItem::separator(handle)?;
        target_menu.insert(&check_item, layout.check_position)?;
        target_menu.insert(&separator, layout.separator_position)?;
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
            target_menu.insert(&simulator, layout.simulator_position)?;
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
        UpdateMenuAction::OpenRepository => {
            if let Err(error) = handle
                .opener()
                .open_url(GITHUB_REPOSITORY_URL, None::<&str>)
            {
                eprintln!("failed to open GitHub repository: {error}");
            }
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
        show_update_in_progress(handle);
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
            prompt_available_update(handle, update, Some(update_guard));
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

fn show_update_in_progress(handle: &AppHandle) {
    handle
        .dialog()
        .message("An update is already in progress.")
        .title("Alook")
        .buttons(MessageDialogButtons::OkCustom("OK".into()))
        .show(|_| {});
}

fn publish_update_prompt(handle: &AppHandle, pending_update: PendingUpdate) {
    let prompt = handle.state::<UpdatePromptState>().replace(pending_update);
    present_update_prompt(handle, prompt);
}

fn present_update_prompt(handle: &AppHandle, prompt: UpdatePrompt) {
    set_update_available(&prompt.available_version);
    crate::commands::show_main_window(handle);
    let version = prompt.available_version.clone();
    let app = handle.clone();
    handle
        .dialog()
        .message(update_prompt_message(&prompt))
        .title("Update Available")
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Update Alook".into(),
            "Later".into(),
        ))
        .show(move |update| {
            if let Err(error) =
                respond_to_update_prompt(&app, &version, UpdatePromptResponse::from(update))
            {
                eprintln!("update prompt response failed: {error}");
            }
        });
}

fn prompt_available_update(
    handle: &AppHandle,
    update: tauri_plugin_updater::Update,
    update_guard: Option<UpdateInProgressGuard<'static>>,
) {
    let prompt = update_prompt(&update.current_version, &update.version);
    publish_update_prompt(
        handle,
        PendingUpdate {
            prompt,
            update: Some(update),
            update_guard,
        },
    );
}

fn respond_to_update_prompt(
    handle: &AppHandle,
    version: &str,
    response: UpdatePromptResponse,
) -> Result<(), String> {
    let state = handle.state::<UpdatePromptState>();
    let Some(mut pending_update) = state.consume_response(version, response)? else {
        return Ok(());
    };

    if pending_update.update_guard.is_none() {
        let Some(update_guard) = UpdateInProgressGuard::acquire(&UPDATE_IN_PROGRESS) else {
            state.restore_if_empty(pending_update);
            show_update_in_progress(handle);
            return Err("an update is already in progress".to_string());
        };
        pending_update.update_guard = Some(update_guard);
    }

    let update = pending_update.update.take().unwrap();
    let update_guard = pending_update.update_guard.take().unwrap();
    let app = handle.clone();
    tauri::async_runtime::spawn(async move {
        download_and_install(app, update, update_guard).await;
    });
    Ok(())
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
                updater.check().await.ok()?
            });

            if let Some(mut update) = found {
                update.timeout = Some(UPDATE_DOWNLOAD_TIMEOUT);
                let version = update.version.clone();
                let already_prompted = automatic_version_prompted(&version);
                let prompt = update_prompt(&update.current_version, &version);
                match handle.state::<UpdatePromptState>().prepare_automatic(
                    PendingUpdate {
                        prompt,
                        update: Some(update),
                        update_guard: None,
                    },
                    &UPDATE_IN_PROGRESS,
                    already_prompted,
                ) {
                    AutomaticOfferDisposition::RefreshMenu => set_update_available(&version),
                    AutomaticOfferDisposition::Blocked => {}
                    AutomaticOfferDisposition::Published(prompt) => {
                        present_update_prompt(&handle, prompt);
                        mark_automatic_prompted(&version);
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
            }

            std::thread::sleep(AUTO_CHECK_INTERVAL);
        }
    });
}

#[cfg(debug_assertions)]
fn simulate_available(handle: &AppHandle) {
    let current_version = handle.package_info().version.to_string();
    let available_version = "9.9.9";
    publish_update_prompt(
        handle,
        PendingUpdate {
            prompt: update_prompt(&current_version, available_version),
            update: None,
            update_guard: None,
        },
    );
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

    fn simulated_pending(current_version: &str, available_version: &str) -> PendingUpdate {
        PendingUpdate {
            prompt: update_prompt(current_version, available_version),
            update: None,
            update_guard: None,
        }
    }

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
            CheckPresentation::PromptAvailable
        );
        assert_eq!(
            presentation_for(CheckSource::Automatic, CheckOutcome::Available, true),
            CheckPresentation::Silent
        );
    }

    #[test]
    fn automatic_versions_prompt_once_while_manual_checks_can_reopen() {
        let mut last_prompted = None;
        assert!(!was_automatic_version_prompted(&mut last_prompted, "1.2.3"));
        assert!(was_automatic_version_prompted(&mut last_prompted, "1.2.3"));
        assert!(!was_automatic_version_prompted(&mut last_prompted, "1.2.4"));
        assert_eq!(
            presentation_for(CheckSource::Manual, CheckOutcome::Available, true),
            CheckPresentation::PromptAvailable
        );
    }

    #[test]
    fn update_prompt_has_only_native_display_metadata() {
        let prompt = update_prompt("1.2.3", "2.0.0");
        assert_eq!(
            prompt,
            UpdatePrompt {
                current_version: "1.2.3".to_string(),
                available_version: "2.0.0".to_string(),
            }
        );
        assert_eq!(
            update_prompt_message(&prompt),
            "Current version: 1.2.3\nNew version: 2.0.0"
        );
    }

    #[test]
    fn native_prompt_result_maps_only_to_update_or_later() {
        assert_eq!(
            UpdatePromptResponse::from(true),
            UpdatePromptResponse::Update
        );
        assert_eq!(
            UpdatePromptResponse::from(false),
            UpdatePromptResponse::Later
        );
    }

    #[test]
    fn pending_prompt_rejects_stale_and_double_responses() {
        let state = UpdatePromptState::default();
        let prompt = state.replace(simulated_pending("1.2.3", "2.0.0"));
        assert_eq!(state.prompt(), Some(prompt.clone()));

        assert!(state.take_matching("1.9.9").is_err());
        assert_eq!(state.prompt(), Some(prompt.clone()));
        assert_eq!(state.take_matching("2.0.0").unwrap().prompt, prompt);
        assert!(state.take_matching("2.0.0").is_err());
    }

    #[test]
    fn later_releases_the_guard_and_manual_reopen_can_replace_the_prompt() {
        static UPDATE_FLAG: AtomicBool = AtomicBool::new(false);
        let state = UpdatePromptState::default();
        let mut pending = simulated_pending("1.2.3", "2.0.0");
        pending.update_guard = UpdateInProgressGuard::acquire(&UPDATE_FLAG);
        state.replace(pending);
        assert!(UPDATE_FLAG.load(Ordering::SeqCst));

        assert!(state
            .consume_response("2.0.0", UpdatePromptResponse::Later)
            .unwrap()
            .is_none());
        assert_eq!(state.prompt(), None);
        assert!(!UPDATE_FLAG.load(Ordering::SeqCst));

        let reopened = state.replace(simulated_pending("1.2.3", "2.0.0"));
        assert_eq!(state.prompt(), Some(reopened));
    }

    #[test]
    fn automatic_offer_stays_silent_during_a_manual_download() {
        static UPDATE_FLAG: AtomicBool = AtomicBool::new(false);
        let state = UpdatePromptState::default();
        let manual_guard = UpdateInProgressGuard::acquire(&UPDATE_FLAG).unwrap();

        assert_eq!(
            state.prepare_automatic(simulated_pending("1.2.3", "2.0.0"), &UPDATE_FLAG, false),
            AutomaticOfferDisposition::Blocked
        );
        assert_eq!(state.prompt(), None);
        assert!(UPDATE_FLAG.load(Ordering::SeqCst));

        drop(manual_guard);
        assert!(!UPDATE_FLAG.load(Ordering::SeqCst));
    }

    #[test]
    fn automatic_offer_does_not_overwrite_pending_state() {
        static UPDATE_FLAG: AtomicBool = AtomicBool::new(false);
        let state = UpdatePromptState::default();
        let existing = state.replace(simulated_pending("1.2.3", "2.0.0"));

        assert_eq!(
            state.prepare_automatic(simulated_pending("1.2.3", "2.1.0"), &UPDATE_FLAG, false),
            AutomaticOfferDisposition::Blocked
        );
        assert_eq!(state.prompt(), Some(existing));
        assert!(!UPDATE_FLAG.load(Ordering::SeqCst));
    }

    #[test]
    fn accepted_automatic_offer_carries_the_existing_guard() {
        static UPDATE_FLAG: AtomicBool = AtomicBool::new(false);
        let state = UpdatePromptState::default();

        let AutomaticOfferDisposition::Published(prompt) =
            state.prepare_automatic(simulated_pending("1.2.3", "2.0.0"), &UPDATE_FLAG, false)
        else {
            panic!("automatic offer should publish");
        };
        assert_eq!(state.prompt(), Some(prompt.clone()));
        assert!(UPDATE_FLAG.load(Ordering::SeqCst));

        let pending = state.take_matching(&prompt.available_version).unwrap();
        assert!(pending.update_guard.is_some());
        drop(pending);
        assert!(!UPDATE_FLAG.load(Ordering::SeqCst));
    }

    #[test]
    fn deduplicated_automatic_offer_refreshes_the_available_menu() {
        static UPDATE_FLAG: AtomicBool = AtomicBool::new(false);
        let state = UpdatePromptState::default();

        assert_eq!(
            state.prepare_automatic(simulated_pending("1.2.3", "2.0.0"), &UPDATE_FLAG, true),
            AutomaticOfferDisposition::RefreshMenu
        );
        assert_eq!(state.prompt(), None);
        assert!(!UPDATE_FLAG.load(Ordering::SeqCst));
    }

    #[test]
    fn real_update_metadata_triggers_one_automatic_prompt_without_rendering_notes() {
        let metadata: serde_json::Value = serde_json::from_str(
            r#"{
                "version": "2.0.0",
                "notes": "A long release changelog that must stay out of the prompt.",
                "pub_date": "2026-06-01T00:00:00Z",
                "platforms": {
                    "darwin-aarch64-app": {
                        "url": "https://example.com/Alook_2.0.0_aarch64.app.tar.gz",
                        "signature": "sig-content-here"
                    }
                }
            }"#,
        )
        .unwrap();
        let version = metadata["version"].as_str().unwrap();
        let notes = metadata["notes"].as_str().unwrap();
        let mut last_prompted = None;
        let already_prompted = was_automatic_version_prompted(&mut last_prompted, version);

        assert_eq!(
            presentation_for(
                CheckSource::Automatic,
                CheckOutcome::Available,
                already_prompted
            ),
            CheckPresentation::PromptAvailable
        );
        let prompt = update_prompt("1.9.0", version);
        assert!(!format!("{prompt:?}").contains(notes));
        assert_eq!(prompt.available_version, "2.0.0");
        assert!(was_automatic_version_prompted(&mut last_prompted, version));
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
    fn menu_routes_checks_and_repository_through_the_app_handler() {
        assert_eq!(
            menu_action(CHECK_FOR_UPDATES_MENU_ID),
            Some(UpdateMenuAction::Check)
        );
        assert_eq!(
            menu_action(GITHUB_REPOSITORY_MENU_ID),
            Some(UpdateMenuAction::OpenRepository)
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
    fn native_update_menu_uses_each_platform_convention() {
        assert_eq!(
            update_menu_layout("macos"),
            UpdateMenuLayout {
                location: UpdateMenuLocation::Application,
                repository_position: 1,
                check_position: 3,
                separator_position: 4,
                simulator_position: 5,
            }
        );
        for target_os in ["windows", "linux"] {
            assert_eq!(
                update_menu_layout(target_os),
                UpdateMenuLayout {
                    location: UpdateMenuLocation::Help,
                    repository_position: 1,
                    check_position: 0,
                    separator_position: 1,
                    simulator_position: 1,
                }
            );
        }
    }

    #[test]
    fn native_menu_and_debug_simulator_are_declared_separately() {
        let source = include_str!("updater.rs");
        let tray_source = include_str!("commands.rs");
        let app_source = include_str!("lib.rs");
        assert!(source.contains("GitHub Repository…"));
        assert!(source.contains(GITHUB_REPOSITORY_URL));
        assert!(source.contains("target_menu.insert(&repository_item, layout.repository_position)"));
        assert!(source.contains("target_menu.insert(&check_item, layout.check_position)"));
        assert!(source.contains("HELP_SUBMENU_ID"));
        assert!(!tray_source.contains("github-repository"));
        assert_eq!(app_source.matches("updater::handle_menu_event").count(), 1);
        assert!(source.contains("#[cfg(debug_assertions)]\n        {"));
        assert!(source.contains("Update Simulator"));
        assert!(source.contains("publish_update_prompt("));
        assert!(!source.contains(&["MessageDialogButtons::Yes", "NoCancelCustom"].concat()));
    }

    #[test]
    fn every_available_path_converges_on_the_one_native_prompt() {
        let source = include_str!("updater.rs");
        assert!(source.contains("prompt_available_update(handle, update, Some(update_guard))"));
        assert!(source.contains("AutomaticOfferDisposition::Published(prompt) =>"));
        assert!(source.contains("present_update_prompt(&handle, prompt)"));
        assert!(source.contains("publish_update_prompt(\n        handle,"));
        assert!(source.contains("respond_to_update_prompt("));
        assert!(source.contains("download_and_install(app, update, update_guard)"));
        assert!(source.contains(".title(\"Update Available\")"));
        assert!(source.contains("Current version: {}\\nNew version: {}"));
        assert!(!source.contains(&["Alook {}", " is available."].concat()));
        assert!(source.contains("MessageDialogButtons::OkCancelCustom("));
        assert!(source.contains("\"Update Alook\".into()"));
        assert!(source.contains("\"Later\".into()"));
        assert!(!source.contains(&["desktop://update", "-available"].concat()));
        assert!(!source.contains(&["desktop_pending", "_update"].concat()));
        assert!(!source.contains(&["desktop_respond", "_update_prompt"].concat()));
        assert!(!source.contains(&["changelog", "_url"].concat()));
    }

    #[test]
    fn automatic_available_notification_remains_unchanged() {
        let source = include_str!("updater.rs");
        assert!(source.contains("Alook Update Available"));
        assert!(source.contains("Open the Alook menu to update"));
    }
}
