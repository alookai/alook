use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf, sync::Mutex};
use tauri::{
    menu::{Menu, MenuItemBuilder, PredefinedMenuItem, Submenu, WINDOW_SUBMENU_ID},
    App, AppHandle, Manager, WebviewWindow,
};

const ZOOM_IN_MENU_ID: &str = "desktop-zoom-in";
const ZOOM_OUT_MENU_ID: &str = "desktop-zoom-out";
const ACTUAL_SIZE_MENU_ID: &str = "desktop-zoom-actual-size";
const VIEW_MENU_ID: &str = "desktop-view-menu";
const SETTINGS_FILE: &str = "zoom.json";
const MIN_PERCENT: u16 = 50;
const MAX_PERCENT: u16 = 200;
const DEFAULT_PERCENT: u16 = 100;
const STEP_PERCENT: u16 = 10;

const MACOS_SHORTCUT_SCRIPT: &str = r#"
window.addEventListener('keydown', (event) => {
  if (!event.metaKey || event.ctrlKey || event.altKey) return
  let action
  if (event.key === '=' || event.key === '+') action = 'in'
  else if (event.key === '-') action = 'out'
  else if (event.key === '0') action = 'reset'
  else return
  event.preventDefault()
  event.stopPropagation()
  window.__TAURI_INTERNALS__.invoke('desktop_zoom_shortcut', { action })
})
"#;

const CONTROL_SHORTCUT_SCRIPT: &str = r#"
window.addEventListener('keydown', (event) => {
  if (!event.ctrlKey || event.metaKey || event.altKey) return
  let action
  if (event.key === '=' || event.key === '+') action = 'in'
  else if (event.key === '-') action = 'out'
  else if (event.key === '0') action = 'reset'
  else return
  event.preventDefault()
  event.stopPropagation()
  window.__TAURI_INTERNALS__.invoke('desktop_zoom_shortcut', { action })
})
"#;

pub fn shortcut_script(target_os: &str) -> &'static str {
    if target_os == "macos" {
        MACOS_SHORTCUT_SCRIPT
    } else {
        CONTROL_SHORTCUT_SCRIPT
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ZoomAction {
    In,
    Out,
    Reset,
}

#[derive(Debug)]
pub struct ZoomState {
    percent: Mutex<u16>,
}

impl Default for ZoomState {
    fn default() -> Self {
        Self {
            percent: Mutex::new(DEFAULT_PERCENT),
        }
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ZoomSettings {
    zoom_percent: u16,
}

fn is_valid_percent(percent: u16) -> bool {
    (MIN_PERCENT..=MAX_PERCENT).contains(&percent) && percent.is_multiple_of(STEP_PERCENT)
}

fn next_percent(current: u16, action: ZoomAction) -> u16 {
    match action {
        ZoomAction::In => current.saturating_add(STEP_PERCENT).min(MAX_PERCENT),
        ZoomAction::Out => current.saturating_sub(STEP_PERCENT).max(MIN_PERCENT),
        ZoomAction::Reset => DEFAULT_PERCENT,
    }
}

fn menu_action(id: &str) -> Option<ZoomAction> {
    match id {
        ZOOM_IN_MENU_ID => Some(ZoomAction::In),
        ZOOM_OUT_MENU_ID => Some(ZoomAction::Out),
        ACTUAL_SIZE_MENU_ID => Some(ZoomAction::Reset),
        _ => None,
    }
}

fn shortcut_action(action: &str) -> Option<ZoomAction> {
    match action {
        "in" => Some(ZoomAction::In),
        "out" => Some(ZoomAction::Out),
        "reset" => Some(ZoomAction::Reset),
        _ => None,
    }
}

fn settings_path(handle: &AppHandle) -> Result<PathBuf, String> {
    handle
        .path()
        .app_config_dir()
        .map(|path| path.join(SETTINGS_FILE))
        .map_err(|error| error.to_string())
}

fn decode_settings(contents: &str) -> u16 {
    serde_json::from_str::<ZoomSettings>(contents)
        .ok()
        .map(|settings| settings.zoom_percent)
        .filter(|percent| is_valid_percent(*percent))
        .unwrap_or(DEFAULT_PERCENT)
}

fn load_percent(path: &PathBuf) -> u16 {
    fs::read_to_string(path)
        .map(|contents| decode_settings(&contents))
        .unwrap_or(DEFAULT_PERCENT)
}

fn persist_percent(path: &PathBuf, percent: u16) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let settings = serde_json::to_vec(&ZoomSettings {
        zoom_percent: percent,
    })
    .map_err(|error| error.to_string())?;
    fs::write(path, settings).map_err(|error| error.to_string())
}

fn apply_action(handle: &AppHandle, action: ZoomAction) -> Result<(), String> {
    let state = handle.state::<ZoomState>();
    let mut current = state.percent.lock().map_err(|error| error.to_string())?;
    let next = next_percent(*current, action);
    if next == *current {
        return Ok(());
    }

    let window = handle
        .get_webview_window("main")
        .ok_or_else(|| "main WebView is unavailable".to_string())?;
    window
        .set_zoom(next as f64 / 100.0)
        .map_err(|error| error.to_string())?;
    *current = next;
    persist_percent(&settings_path(handle)?, next)
}

fn view_submenu(handle: &AppHandle, menu: &Menu<tauri::Wry>) -> tauri::Result<Submenu<tauri::Wry>> {
    let items = menu.items()?;
    for item in &items {
        if let Some(submenu) = item.as_submenu() {
            if submenu.text()? == "View" {
                return Ok(submenu.clone());
            }
        }
    }

    let view = Submenu::with_id(handle, VIEW_MENU_ID, "View", true)?;
    let position = items
        .iter()
        .position(|item| item.id().as_ref() == WINDOW_SUBMENU_ID)
        .unwrap_or(items.len());
    menu.insert(&view, position)?;
    Ok(view)
}

pub fn extend_app_menu(handle: &AppHandle, menu: &Menu<tauri::Wry>) -> tauri::Result<()> {
    let zoom_in = MenuItemBuilder::with_id(ZOOM_IN_MENU_ID, "Zoom In")
        .accelerator("CmdOrCtrl+=")
        .build(handle)?;
    let zoom_out = MenuItemBuilder::with_id(ZOOM_OUT_MENU_ID, "Zoom Out")
        .accelerator("CmdOrCtrl+-")
        .build(handle)?;
    let actual_size = MenuItemBuilder::with_id(ACTUAL_SIZE_MENU_ID, "Actual Size")
        .accelerator("CmdOrCtrl+0")
        .build(handle)?;
    let separator = PredefinedMenuItem::separator(handle)?;
    let view = view_submenu(handle, menu)?;
    view.insert(&separator, 0)?;
    view.insert(&actual_size, 0)?;
    view.insert(&zoom_out, 0)?;
    view.insert(&zoom_in, 0)
}

pub fn restore(app: &App) -> tauri::Result<()> {
    let handle = app.handle();
    let percent = settings_path(handle)
        .map(|path| load_percent(&path))
        .unwrap_or(DEFAULT_PERCENT);
    *handle
        .state::<ZoomState>()
        .percent
        .lock()
        .unwrap_or_else(|error| error.into_inner()) = percent;
    if let Some(window) = handle.get_webview_window("main") {
        window.set_zoom(percent as f64 / 100.0)?;
    }
    Ok(())
}

pub fn handle_menu_event(handle: &AppHandle, id: &str) -> Result<bool, String> {
    let Some(action) = menu_action(id) else {
        return Ok(false);
    };
    apply_action(handle, action)?;
    Ok(true)
}

#[tauri::command]
pub fn desktop_zoom_shortcut(window: WebviewWindow, action: &str) -> Result<(), String> {
    if window.label() != "main" {
        return Ok(());
    }
    let action = shortcut_action(action).ok_or_else(|| "unknown zoom action".to_string())?;
    apply_action(window.app_handle(), action)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zoom_steps_are_exact_and_bounded() {
        assert_eq!(next_percent(100, ZoomAction::In), 110);
        assert_eq!(next_percent(100, ZoomAction::Out), 90);
        assert_eq!(next_percent(MAX_PERCENT, ZoomAction::In), MAX_PERCENT);
        assert_eq!(next_percent(MIN_PERCENT, ZoomAction::Out), MIN_PERCENT);
        assert_eq!(next_percent(170, ZoomAction::Reset), DEFAULT_PERCENT);
    }

    #[test]
    fn persisted_zoom_requires_a_supported_step() {
        for percent in (MIN_PERCENT..=MAX_PERCENT).step_by(STEP_PERCENT as usize) {
            assert_eq!(
                decode_settings(&format!(r#"{{"zoomPercent":{percent}}}"#)),
                percent
            );
        }
        for contents in [
            "",
            "null",
            r#"{"zoomPercent":49}"#,
            r#"{"zoomPercent":55}"#,
            r#"{"zoomPercent":201}"#,
            r#"{"zoomPercent":110.5}"#,
        ] {
            assert_eq!(decode_settings(contents), DEFAULT_PERCENT);
        }
    }

    #[test]
    fn menu_and_shortcut_routes_share_zoom_actions() {
        assert_eq!(menu_action(ZOOM_IN_MENU_ID), shortcut_action("in"));
        assert_eq!(menu_action(ZOOM_OUT_MENU_ID), shortcut_action("out"));
        assert_eq!(menu_action(ACTUAL_SIZE_MENU_ID), shortcut_action("reset"));
        assert_eq!(menu_action("unknown"), None);
        assert_eq!(shortcut_action("unknown"), None);
    }

    #[test]
    fn shortcut_script_handles_plus_minus_and_reset_without_browser_fallback() {
        for script in [shortcut_script("macos"), shortcut_script("windows")] {
            assert!(script.contains("event.key === '=' || event.key === '+'"));
            assert!(script.contains("event.key === '-'"));
            assert!(script.contains("event.key === '0'"));
            assert!(script.contains("event.preventDefault()"));
            assert!(script.contains("desktop_zoom_shortcut"));
        }
        assert!(shortcut_script("macos").contains("event.metaKey"));
        assert!(shortcut_script("windows").contains("event.ctrlKey"));
        assert_eq!(shortcut_script("linux"), shortcut_script("windows"));
    }
}
