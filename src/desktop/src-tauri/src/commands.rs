use serde::Serialize;
use tauri::{AppHandle, Manager};

#[cfg(desktop)]
use tauri_plugin_shell::ShellExt;

#[cfg(desktop)]
use tauri_plugin_notification::NotificationExt;

use std::path::PathBuf;

#[cfg(desktop)]
use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Serialize)]
pub struct CommandResult {
    pub success: bool,
    pub message: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DaemonRuntimeCapability {
    pub available: bool,
    pub reason: Option<String>,
    pub node_version: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct DaemonConfig {
    command: &'static str,
    base_args: &'static [&'static str],
    cwd: Option<PathBuf>,
}

#[cfg(desktop)]
fn resolve_path() -> String {
    use std::sync::OnceLock;
    static CACHED: OnceLock<String> = OnceLock::new();
    CACHED
        .get_or_init(|| {
            let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
            if let Ok(output) = std::process::Command::new(&shell)
                .args(["-ilc", "echo $PATH"])
                .output()
            {
                let shell_path = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if !shell_path.is_empty() {
                    return shell_path;
                }
            }
            std::env::var("PATH").unwrap_or_default()
        })
        .clone()
}

#[cfg(desktop)]
fn daemon_config() -> DaemonConfig {
    daemon_config_for(cfg!(debug_assertions))
}

fn daemon_config_for(is_debug: bool) -> DaemonConfig {
    if is_debug {
        let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let monorepo_root = manifest_dir
            .parent()
            .and_then(|p| p.parent())
            .and_then(|p| p.parent())
            .map(|p| p.to_path_buf());
        DaemonConfig {
            command: "pnpm",
            base_args: &[],
            cwd: monorepo_root,
        }
    } else {
        DaemonConfig {
            command: "npx",
            base_args: &["--yes", "@alook/daemon"],
            cwd: None,
        }
    }
}

fn daemon_endpoints_for(is_debug: bool) -> (&'static str, &'static str) {
    if is_debug {
        ("http://localhost:3000", "ws://localhost:8789")
    } else {
        ("https://alook.ai", "wss://alook.ai/api/ws/community-daemon")
    }
}

#[cfg(desktop)]
struct DaemonOutput {
    success: bool,
    stdout: String,
    stderr: String,
}

#[cfg(desktop)]
async fn run_daemon(app: &AppHandle, extra_args: &[String]) -> Result<DaemonOutput, String> {
    let cfg = daemon_config();
    let mut args: Vec<String> = cfg.base_args.iter().map(|arg| (*arg).to_string()).collect();
    args.extend_from_slice(extra_args);

    let mut cmd = app.shell().command(cfg.command);
    cmd = cmd.env("PATH", resolve_path());
    if let Some(cwd) = &cfg.cwd {
        cmd = cmd.current_dir(cwd.clone());
    }
    let output = cmd.args(&args).output().await.map_err(|e| e.to_string())?;

    Ok(DaemonOutput {
        success: output.status.success(),
        stdout: String::from_utf8_lossy(&output.stdout).trim().to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
    })
}

fn valid_machine_key(machine_key: &str) -> bool {
    let value = machine_key
        .strip_prefix("cmt_")
        .or_else(|| machine_key.strip_prefix("cmk_"));
    let Some(value) = value else {
        return false;
    };
    value.len() == 32
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn daemon_pair_args(machine_key: &str, is_debug: bool) -> Result<Vec<String>, String> {
    if !valid_machine_key(machine_key) {
        return Err("invalid Community machine key".to_string());
    }
    let (server_url, ws_url) = daemon_endpoints_for(is_debug);
    Ok(vec![
        "daemon".to_string(),
        "start".to_string(),
        "--machine-key".to_string(),
        machine_key.to_string(),
        "--server-url".to_string(),
        server_url.to_string(),
        "--ws-url".to_string(),
        ws_url.to_string(),
    ])
}

fn evaluate_runtime_capability(
    node: Result<String, String>,
    npm: Result<String, String>,
    npx: Result<String, String>,
) -> DaemonRuntimeCapability {
    let node_output = match node {
        Ok(output) => output,
        Err(reason) => {
            return DaemonRuntimeCapability {
                available: false,
                reason: Some(format!("Node.js is required: {reason}.")),
                node_version: None,
            };
        }
    };
    for result in [npm, npx] {
        if let Err(reason) = result {
            return DaemonRuntimeCapability {
                available: false,
                reason: Some(format!(
                    "Node.js is available, but {reason}. Install npm with Node.js and try again."
                )),
                node_version: (!node_output.is_empty()).then_some(node_output),
            };
        }
    }
    DaemonRuntimeCapability {
        available: true,
        reason: None,
        node_version: (!node_output.is_empty()).then_some(node_output),
    }
}

fn daemon_failure_message(stdout: &str, stderr: &str) -> String {
    let detail = if !stderr.trim().is_empty() {
        stderr.trim()
    } else if !stdout.trim().is_empty() {
        stdout.trim()
    } else {
        "The daemon process exited before it reported a reason."
    };
    format!("The daemon couldn't start: {detail}")
}

#[cfg(desktop)]
async fn probe_runtime_command(app: &AppHandle, command: &str) -> Result<String, String> {
    let output = app
        .shell()
        .command(command)
        .env("PATH", resolve_path())
        .arg("--version")
        .output()
        .await
        .map_err(|_| format!("{command} was not found"))?;
    if !output.status.success() {
        return Err(format!("{command} could not run"));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

// --- Splashscreen ---

#[cfg(desktop)]
static SPLASH_CLOSED: AtomicBool = AtomicBool::new(false);

#[cfg(desktop)]
static SPLASH_FRONTEND_READY: AtomicBool = AtomicBool::new(false);

#[cfg(desktop)]
static SPLASH_MIN_ELAPSED: AtomicBool = AtomicBool::new(false);

#[cfg(desktop)]
pub fn splash_html() -> String {
    use base64::Engine;
    let icon_bytes = include_bytes!("../icons/icon.png");
    let icon_b64 = base64::engine::general_purpose::STANDARD.encode(icon_bytes);
    format!(
        concat!(
            "<html><head><meta charset=\"utf-8\"><style>",
            "*{{margin:0;padding:0;box-sizing:border-box}}",
            "html,body{{width:100%;height:100%;overflow:hidden;background:transparent;",
            "display:flex;align-items:center;justify-content:center;",
            "-webkit-user-select:none;user-select:none}}",
            ".logo{{width:96px;height:96px;border-radius:22px;opacity:0;",
            "animation:fi .4s ease-out .1s forwards;",
            "box-shadow:0 8px 32px rgba(0,0,0,0.18)}}",
            "@keyframes fi{{from{{opacity:0;transform:scale(.88)}}to{{opacity:1;transform:scale(1)}}}}",
            "</style></head><body>",
            "<img class=\"logo\" src=\"data:image/png;base64,{}\" draggable=\"false\">",
            "</body></html>",
        ),
        icon_b64
    )
}

#[cfg(desktop)]
pub fn create_splash_window(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::{WebviewUrl, WebviewWindowBuilder};

    WebviewWindowBuilder::new(
        app,
        "splash",
        WebviewUrl::CustomProtocol("splash://index".parse()?),
    )
    .title("Alook")
    .inner_size(200.0, 200.0)
    .center()
    .decorations(false)
    .resizable(false)
    .transparent(true)
    .shadow(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .build()?;

    Ok(())
}

#[cfg(desktop)]
fn do_close_splashscreen(handle: &AppHandle) {
    if SPLASH_CLOSED.swap(true, Ordering::SeqCst) {
        return;
    }
    if let Some(main) = handle.get_webview_window("main") {
        let _ = main.show();
        let _ = main.set_focus();
    }
    let h = handle.clone();
    std::thread::spawn(move || {
        fade_out_and_close_splash(&h);
    });
}

#[cfg(desktop)]
fn fade_out_and_close_splash(handle: &AppHandle) {
    let Some(splash) = handle.get_webview_window("splash") else {
        return;
    };

    #[cfg(target_os = "macos")]
    {
        use objc2::msg_send;
        use objc2::runtime::AnyObject;
        unsafe {
            let ns_window = splash.ns_window().unwrap() as *mut AnyObject;
            for i in (0..=5).rev() {
                let alpha = i as f64 / 5.0;
                let _: () = msg_send![ns_window, setAlphaValue: alpha];
                std::thread::sleep(std::time::Duration::from_millis(40));
            }
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        std::thread::sleep(std::time::Duration::from_millis(200));
    }

    let _ = splash.close();
}

#[cfg(desktop)]
fn try_close_splashscreen(handle: &AppHandle) {
    let frontend = SPLASH_FRONTEND_READY.load(Ordering::SeqCst);
    let min = SPLASH_MIN_ELAPSED.load(Ordering::SeqCst);
    if frontend && min {
        do_close_splashscreen(handle);
    }
}

#[cfg(desktop)]
pub fn mark_splash_min_elapsed(handle: &AppHandle) {
    SPLASH_MIN_ELAPSED.store(true, Ordering::SeqCst);
    try_close_splashscreen(handle);
}

#[cfg(desktop)]
#[tauri::command]
pub fn close_splashscreen(app: AppHandle) {
    SPLASH_FRONTEND_READY.store(true, Ordering::SeqCst);
    try_close_splashscreen(&app);
}

// --- Daemon commands ---

#[cfg(desktop)]
#[tauri::command]
pub async fn daemon_runtime_capability(app: AppHandle) -> DaemonRuntimeCapability {
    let node = probe_runtime_command(&app, "node").await;
    let npm = probe_runtime_command(&app, "npm").await;
    let npx = probe_runtime_command(&app, "npx").await;
    evaluate_runtime_capability(node, npm, npx)
}

#[cfg(desktop)]
#[tauri::command]
pub async fn daemon_pair(app: AppHandle, machine_key: String) -> Result<CommandResult, String> {
    let args = daemon_pair_args(&machine_key, cfg!(debug_assertions))?;
    let output = run_daemon(&app, &args).await?;
    if output.success {
        Ok(CommandResult {
            success: true,
            message: "Daemon paired and started".to_string(),
        })
    } else {
        Ok(CommandResult {
            success: false,
            message: daemon_failure_message(&output.stdout, &output.stderr),
        })
    }
}

// --- App updater ---

#[derive(Serialize, Clone)]
pub struct UpdateInfo {
    pub available: bool,
    pub version: Option<String>,
    pub notes: Option<String>,
}

#[derive(Serialize, Clone)]
struct UpdateProgress {
    percent: f64,
    downloaded: u64,
    total: Option<u64>,
}

#[cfg(desktop)]
#[tauri::command]
pub async fn check_for_updates(app: AppHandle) -> Result<UpdateInfo, String> {
    use tauri_plugin_updater::UpdaterExt;
    let updater = app.updater().map_err(|e| e.to_string())?;
    match updater.check().await {
        Ok(Some(update)) => Ok(UpdateInfo {
            available: true,
            version: Some(update.version.clone()),
            notes: update.body.clone(),
        }),
        Ok(None) => Ok(UpdateInfo {
            available: false,
            version: None,
            notes: None,
        }),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(desktop)]
#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<(), String> {
    use tauri::Emitter;
    use tauri_plugin_updater::UpdaterExt;

    let updater = app.updater().map_err(|e| e.to_string())?;
    let update = updater
        .check()
        .await
        .map_err(|e| e.to_string())?
        .ok_or("No update available".to_string())?;

    let handle = app.clone();
    let mut cumulative: u64 = 0;
    update
        .download_and_install(
            move |chunk_size, total| {
                cumulative += chunk_size as u64;
                let percent = total
                    .map(|t| (cumulative as f64 / t as f64) * 100.0)
                    .unwrap_or(0.0);
                let _ = handle.emit(
                    "update://progress",
                    UpdateProgress {
                        percent,
                        downloaded: cumulative,
                        total,
                    },
                );
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())?;

    app.restart();
}

#[cfg(desktop)]
#[tauri::command]
pub fn set_window_theme(window: tauri::WebviewWindow, dark: bool) {
    let _ = (&window, dark);
    #[cfg(target_os = "macos")]
    {
        use objc2::msg_send;
        use objc2::runtime::AnyObject;

        unsafe {
            let ns_window = window.ns_window().unwrap() as *mut AnyObject;
            let (r, g, b) = if dark {
                (0.063f64, 0.051f64, 0.039f64)
            } else {
                (0.929f64, 0.910f64, 0.871f64)
            };
            let color: *mut AnyObject = msg_send![
                objc2::class!(NSColor),
                colorWithRed: r,
                green: g,
                blue: b,
                alpha: 1.0f64
            ];
            let _: () = msg_send![ns_window, setBackgroundColor: color];
        }
    }
}

#[cfg(desktop)]
static UPDATE_AVAILABLE_VERSION: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

#[cfg(desktop)]
static UPDATE_IN_PROGRESS: AtomicBool = AtomicBool::new(false);

#[cfg(desktop)]
pub fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

// --- System tray ---
#[cfg(desktop)]
pub fn setup_tray(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::{
        image::Image,
        menu::{MenuBuilder, MenuItemBuilder},
        tray::TrayIconBuilder,
    };

    let show = MenuItemBuilder::with_id("show", "Open Alook").build(app)?;
    let version =
        MenuItemBuilder::with_id("version", format!("Version {}", app.package_info().version))
            .enabled(false)
            .build(app)?;
    let update_item = MenuItemBuilder::with_id("update", "Check for Alook Updates…").build(app)?;
    let quit = MenuItemBuilder::with_id("quit", "Quit").build(app)?;

    let menu = MenuBuilder::new(app)
        .item(&show)
        .separator()
        .item(&version)
        .item(&update_item)
        .separator()
        .item(&quit)
        .build()?;

    let _tray = TrayIconBuilder::new()
        .icon(Image::from_bytes(include_bytes!("../icons/tray-default.png")).expect("tray icon"))
        .icon_as_template(true)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("Alook")
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "show" => show_main_window(app),
            "update" => {
                let handle = app.clone();
                tauri::async_runtime::spawn(async move {
                    do_install_update(&handle).await;
                });
            }
            "quit" => {
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let tauri::tray::TrayIconEvent::Click {
                button: tauri::tray::MouseButton::Left,
                button_state: tauri::tray::MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}

// --- Update flow ---

#[cfg(desktop)]
async fn do_install_update(handle: &AppHandle) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
    use tauri_plugin_updater::UpdaterExt;

    if UPDATE_IN_PROGRESS.swap(true, Ordering::SeqCst) {
        handle
            .dialog()
            .message("An update is already in progress.")
            .title("Alook")
            .buttons(MessageDialogButtons::OkCustom("OK".into()))
            .show(|_| {});
        return;
    }

    let updater = match handle.updater() {
        Ok(u) => u,
        Err(e) => {
            UPDATE_IN_PROGRESS.store(false, Ordering::SeqCst);
            handle
                .dialog()
                .message(format!("Could not check for updates: {}", e))
                .title("Update Check Failed")
                .buttons(MessageDialogButtons::OkCustom("OK".into()))
                .show(|_| {});
            return;
        }
    };

    match updater.check().await {
        Ok(Some(update)) => {
            let version = update.version.clone();
            let notes = update.body.clone().unwrap_or_default();
            let msg = if notes.is_empty() {
                format!("Version {} is available. Download and install?", version)
            } else {
                format!(
                    "Version {} is available.\n\n{}\n\nDownload and install?",
                    version, notes
                )
            };

            let h = handle.clone();
            handle
                .dialog()
                .message(&msg)
                .title("Update Available")
                .buttons(MessageDialogButtons::OkCancelCustom(
                    "Update".into(),
                    "Later".into(),
                ))
                .show(move |confirmed| {
                    if !confirmed {
                        UPDATE_IN_PROGRESS.store(false, Ordering::SeqCst);
                        return;
                    }
                    tauri::async_runtime::spawn(async move {
                        install_checked_update(h, update).await;
                    });
                });
        }
        Ok(None) => {
            UPDATE_IN_PROGRESS.store(false, Ordering::SeqCst);
            handle
                .dialog()
                .message("You're on the latest version.")
                .title("No Updates Available")
                .buttons(MessageDialogButtons::OkCustom("OK".into()))
                .show(|_| {});
        }
        Err(e) => {
            UPDATE_IN_PROGRESS.store(false, Ordering::SeqCst);
            handle
                .dialog()
                .message(format!("Could not check for updates: {}", e))
                .title("Update Check Failed")
                .buttons(MessageDialogButtons::OkCustom("OK".into()))
                .show(|_| {});
        }
    }
}

#[cfg(desktop)]
async fn install_checked_update(handle: AppHandle, update: tauri_plugin_updater::Update) {
    use tauri::Emitter;
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

    let version = update.version.clone();
    let _ = handle
        .notification()
        .builder()
        .title("Alook")
        .body(format!("Downloading v{version}…"))
        .show();

    let h = handle.clone();
    let mut cumulative: u64 = 0;
    let result = update
        .download_and_install(
            move |chunk_size, total| {
                cumulative += chunk_size as u64;
                let percent = total
                    .map(|value| (cumulative as f64 / value as f64) * 100.0)
                    .unwrap_or(0.0);
                let _ = h.emit(
                    "update://progress",
                    UpdateProgress {
                        percent,
                        downloaded: cumulative,
                        total,
                    },
                );
            },
            || {},
        )
        .await;

    match result {
        Ok(()) => {
            let h = handle.clone();
            handle
                .dialog()
                .message(format!(
                    "Version {version} has been installed. Restart now?"
                ))
                .title("Update Complete")
                .buttons(MessageDialogButtons::OkCancelCustom(
                    "Restart".into(),
                    "Later".into(),
                ))
                .show(move |restart| {
                    if restart {
                        h.restart();
                    } else {
                        UPDATE_IN_PROGRESS.store(false, Ordering::SeqCst);
                    }
                });
        }
        Err(error) => {
            UPDATE_IN_PROGRESS.store(false, Ordering::SeqCst);
            handle
                .dialog()
                .message(format!("Download failed: {error}"))
                .title("Update Failed")
                .buttons(MessageDialogButtons::OkCustom("Close".into()))
                .show(|_| {});
        }
    }
}

#[cfg(desktop)]
pub fn auto_check_updates(handle: AppHandle) {
    use tauri_plugin_updater::UpdaterExt;

    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(30));

        let interval = std::time::Duration::from_secs(30 * 60);
        loop {
            let h = handle.clone();
            let found = tauri::async_runtime::block_on(async {
                let updater = h.updater().ok()?;
                let update = updater.check().await.ok()??;
                Some(update.version.clone())
            });

            if let Some(version) = found {
                let mut guard = UPDATE_AVAILABLE_VERSION
                    .lock()
                    .unwrap_or_else(|e| e.into_inner());
                let already_notified = guard.as_deref() == Some(&*version);
                if !already_notified {
                    *guard = Some(version.clone());
                    drop(guard);
                    let _ = handle
                        .notification()
                        .builder()
                        .title("Alook Update Available")
                        .body(format!(
                            "Version {} is ready to install. Use the tray menu to update.",
                            version
                        ))
                        .show();
                }
            }

            std::thread::sleep(interval);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_capability_requires_node_npm_and_npx() {
        let ok = || Ok("10.9.3".to_string());
        let old = evaluate_runtime_capability(Ok("v16.0.0".to_string()), ok(), ok());
        assert!(old.available);
        assert_eq!(old.node_version.as_deref(), Some("v16.0.0"));

        let unrecognized = evaluate_runtime_capability(Ok("not-a-version".to_string()), ok(), ok());
        assert!(unrecognized.available);

        let missing_npm = evaluate_runtime_capability(
            Ok("v22.0.0".to_string()),
            Err("npm was not found".to_string()),
            ok(),
        );
        assert!(!missing_npm.available);
        assert!(missing_npm.reason.unwrap().contains("npm was not found"));

        let missing_npx = evaluate_runtime_capability(
            Ok("v22.0.0".to_string()),
            ok(),
            Err("npx was not found".to_string()),
        );
        assert!(!missing_npx.available);
        assert!(missing_npx.reason.unwrap().contains("npx was not found"));
    }

    #[test]
    fn daemon_failure_prefers_stderr_and_falls_back_to_stdout() {
        assert_eq!(
            daemon_failure_message("less useful stdout", "Node.js 20.9 or newer is required"),
            "The daemon couldn't start: Node.js 20.9 or newer is required"
        );
        assert_eq!(
            daemon_failure_message("npm failed", ""),
            "The daemon couldn't start: npm failed"
        );
        assert_eq!(
            daemon_failure_message("", ""),
            "The daemon couldn't start: The daemon process exited before it reported a reason."
        );
    }

    #[test]
    fn daemon_config_selects_repository_and_published_commands() {
        let debug = daemon_config_for(true);
        assert_eq!(debug.command, "pnpm");
        assert!(debug.base_args.is_empty());
        assert!(debug.cwd.is_some());

        let release = daemon_config_for(false);
        assert_eq!(release.command, "npx");
        assert_eq!(release.base_args, &["--yes", "@alook/daemon"]);
        assert!(release.cwd.is_none());
    }

    #[test]
    fn daemon_endpoints_are_fixed_at_the_native_boundary() {
        assert_eq!(
            daemon_endpoints_for(true),
            ("http://localhost:3000", "ws://localhost:8789")
        );
        assert_eq!(
            daemon_endpoints_for(false),
            ("https://alook.ai", "wss://alook.ai/api/ws/community-daemon")
        );
    }

    #[test]
    fn pairing_accepts_only_machine_keys_and_builds_fixed_arguments() {
        for key in [
            "cmt_abcdefghijklmnopqrstuvwxyz012345",
            "cmk_abcDEF0123456789_-abcdefghijklmn",
        ] {
            let args = daemon_pair_args(key, false).unwrap();
            assert_eq!(
                args,
                vec![
                    "daemon",
                    "start",
                    "--machine-key",
                    key,
                    "--server-url",
                    "https://alook.ai",
                    "--ws-url",
                    "wss://alook.ai/api/ws/community-daemon",
                ]
            );
            assert!(!args.iter().any(|arg| arg == "--base-dir"));
        }

        for invalid in [
            "cmt_too_short",
            "cmk_has spaces",
            "cm_machine_1234",
            "--server-url=https://example.com",
        ] {
            assert!(daemon_pair_args(invalid, false).is_err());
        }
    }

    #[test]
    fn development_pairing_uses_only_fixed_local_endpoints() {
        let args = daemon_pair_args("cmt_abcdefghijklmnopqrstuvwxyz012345", true).unwrap();
        assert_eq!(args[5], "http://localhost:3000");
        assert_eq!(args[7], "ws://localhost:8789");
        assert_eq!(args.len(), 8);
    }

    #[test]
    fn desktop_registers_no_daemon_lifecycle_commands() {
        let app_source = include_str!("lib.rs");
        for rejected in [
            "commands::daemon_start",
            "commands::daemon_stop",
            "commands::daemon_status",
            "commands::register_cli",
            "commands::cli_update",
            "commands::cli_check",
            "auto_start_daemon",
            "prevent_exit",
        ] {
            assert!(
                !app_source.contains(rejected),
                "found rejected lifecycle hook: {rejected}"
            );
        }
    }

    #[test]
    fn desktop_restores_the_main_window_on_macos_reopen() {
        let app_source = include_str!("lib.rs");
        assert!(app_source.contains("tauri::RunEvent::Reopen"));
        assert!(app_source.contains("commands::show_main_window(app)"));
    }
}
