use serde::Serialize;
use tauri::{AppHandle, Manager};

#[cfg(desktop)]
use tauri_plugin_shell::ShellExt;

#[cfg(desktop)]
use tauri_plugin_notification::NotificationExt;

#[cfg(desktop)]
use std::path::PathBuf;

#[cfg(desktop)]
use std::sync::atomic::{AtomicBool, Ordering};


#[derive(Serialize)]
pub struct DaemonStatusResult {
    pub running: bool,
    pub pid: Option<u32>,
    pub version: Option<String>,
}

#[derive(Serialize)]
pub struct CommandResult {
    pub success: bool,
    pub message: String,
}

#[derive(Serialize)]
pub struct CliInfo {
    pub command: String,
    pub is_dev: bool,
}

#[cfg(desktop)]
struct CliConfig {
    command: &'static str,
    base_args: &'static [&'static str],
    env: Vec<(&'static str, &'static str)>,
    cwd: Option<PathBuf>,
}

#[cfg(desktop)]
fn resolve_path() -> String {
    use std::sync::OnceLock;
    static CACHED: OnceLock<String> = OnceLock::new();
    CACHED.get_or_init(|| {
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
    }).clone()
}

#[cfg(desktop)]
fn cli_config() -> CliConfig {
    if cfg!(debug_assertions) {
        let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let monorepo_root = manifest_dir
            .parent()
            .and_then(|p| p.parent())
            .and_then(|p| p.parent())
            .map(|p| p.to_path_buf());
        CliConfig {
            command: "pnpm",
            base_args: &["dev:cli"],
            env: vec![],
            cwd: monorepo_root,
        }
    } else {
        CliConfig {
            command: "npx",
            base_args: &["@alook/cli"],
            env: vec![],
            cwd: None,
        }
    }
}

#[cfg(desktop)]
struct CliOutput {
    success: bool,
    stdout: String,
    stderr: String,
}

#[cfg(desktop)]
async fn run_cli(app: &AppHandle, extra_args: &[&str]) -> Result<CliOutput, String> {
    let cfg = cli_config();
    let mut args: Vec<&str> = cfg.base_args.to_vec();
    args.extend_from_slice(extra_args);

    let mut cmd = app.shell().command(cfg.command);
    cmd = cmd.env("PATH", resolve_path());
    for (key, val) in &cfg.env {
        cmd = cmd.env(key, val);
    }
    if let Some(cwd) = &cfg.cwd {
        cmd = cmd.current_dir(cwd.clone());
    }
    let output = cmd.args(&args).output().await.map_err(|e| e.to_string())?;

    Ok(CliOutput {
        success: output.status.success(),
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
    })
}

#[cfg(desktop)]
fn to_command_result(output: CliOutput) -> CommandResult {
    CommandResult {
        success: output.success,
        message: if output.success {
            output.stdout
        } else if output.stderr.trim().is_empty() {
            output.stdout
        } else {
            output.stderr
        },
    }
}

// --- Splashscreen ---

#[cfg(desktop)]
static SPLASH_CLOSED: AtomicBool = AtomicBool::new(false);

#[cfg(desktop)]
static SPLASH_READY: AtomicBool = AtomicBool::new(false);

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

    WebviewWindowBuilder::new(app, "splash", WebviewUrl::CustomProtocol("splash://index".parse()?))
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
pub fn do_close_splashscreen(handle: &AppHandle) {
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
    let Some(splash) = handle.get_webview_window("splash") else { return };

    #[cfg(target_os = "macos")]
    {
        use objc2::runtime::AnyObject;
        use objc2::msg_send;
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
    if SPLASH_READY.load(Ordering::SeqCst) && SPLASH_MIN_ELAPSED.load(Ordering::SeqCst) {
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
    SPLASH_READY.store(true, Ordering::SeqCst);
    try_close_splashscreen(&app);
}

// --- CLI commands ---

#[cfg(desktop)]
#[tauri::command]
pub fn get_cli_info() -> CliInfo {
    let cfg = cli_config();
    CliInfo {
        command: format!("{} {}", cfg.command, cfg.base_args.join(" ")),
        is_dev: cfg!(debug_assertions),
    }
}

#[cfg(desktop)]
#[tauri::command]
pub async fn register_cli(app: AppHandle, token: String) -> Result<CommandResult, String> {
    let cfg = cli_config();
    let mut args: Vec<&str> = cfg.base_args.to_vec();
    args.extend_from_slice(&["register", "--token"]);
    let token_ref: &str = &token;

    let mut cmd = app.shell().command(cfg.command);
    cmd = cmd.env("PATH", resolve_path());
    for (key, val) in &cfg.env {
        cmd = cmd.env(key, val);
    }
    if let Some(cwd) = &cfg.cwd {
        cmd = cmd.current_dir(cwd.clone());
    }
    let output = cmd
        .args(&args)
        .arg(token_ref)
        .output()
        .await
        .map_err(|e| e.to_string())?;

    let cli_output = CliOutput {
        success: output.status.success(),
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
    };
    Ok(to_command_result(cli_output))
}

#[cfg(desktop)]
#[tauri::command]
pub async fn daemon_start(app: AppHandle) -> Result<CommandResult, String> {
    let output = run_cli(&app, &["daemon", "start"]).await?;
    Ok(to_command_result(output))
}

#[cfg(desktop)]
#[tauri::command]
pub async fn daemon_stop(app: AppHandle) -> Result<CommandResult, String> {
    let output = run_cli(&app, &["daemon", "stop"]).await?;
    Ok(to_command_result(output))
}

#[cfg(desktop)]
#[tauri::command]
pub async fn daemon_status(app: AppHandle) -> Result<DaemonStatusResult, String> {
    let output = run_cli(&app, &["daemon", "status"]).await?;
    Ok(parse_daemon_status(&output.stdout))
}

#[cfg(desktop)]
#[tauri::command]
pub async fn cli_update(app: AppHandle) -> Result<CommandResult, String> {
    if cfg!(debug_assertions) {
        return Ok(CommandResult {
            success: true,
            message: "CLI update skipped in dev mode".to_string(),
        });
    }

    let mut stop_cmd = app.shell().command("npx");
    stop_cmd = stop_cmd.env("PATH", resolve_path());
    let _ = stop_cmd
        .args(["--yes", "@alook/cli", "daemon", "stop"])
        .output()
        .await;

    let mut start_cmd = app.shell().command("npx");
    start_cmd = start_cmd.env("PATH", resolve_path());
    let start_output = start_cmd
        .args(["--yes", "@alook/cli@latest", "daemon", "start"])
        .output()
        .await
        .map_err(|e| e.to_string())?;

    Ok(CommandResult {
        success: start_output.status.success(),
        message: if start_output.status.success() {
            "CLI updated and daemon restarted".to_string()
        } else {
            String::from_utf8_lossy(&start_output.stderr).to_string()
        },
    })
}

#[cfg(desktop)]
#[tauri::command]
pub async fn cli_check(app: AppHandle) -> Result<CommandResult, String> {
    let output = run_cli(&app, &["--version"]).await?;
    Ok(CommandResult {
        success: output.success,
        message: output.stdout.trim().to_string(),
    })
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
    use tauri_plugin_updater::UpdaterExt;
    use tauri::Emitter;

    let updater = app.updater().map_err(|e| e.to_string())?;
    let update = updater.check().await.map_err(|e| e.to_string())?
        .ok_or("No update available".to_string())?;

    let handle = app.clone();
    let mut cumulative: u64 = 0;
    update.download_and_install(
        move |chunk_size, total| {
            cumulative += chunk_size as u64;
            let percent = total.map(|t| (cumulative as f64 / t as f64) * 100.0).unwrap_or(0.0);
            let _ = handle.emit("update://progress", UpdateProgress {
                percent,
                downloaded: cumulative,
                total,
            });
        },
        || {},
    ).await.map_err(|e| e.to_string())?;

    app.restart();
}

#[cfg(desktop)]
#[tauri::command]
pub fn set_window_theme(window: tauri::WebviewWindow, dark: bool) {
    let _ = (&window, dark);
    #[cfg(target_os = "macos")]
    {
        use objc2::runtime::AnyObject;
        use objc2::msg_send;

        unsafe {
            let ns_window = window.ns_window().unwrap() as *mut AnyObject;
            let (r, g, b) = if dark {
                (0.137f64, 0.129f64, 0.118f64)
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
#[tauri::command]
pub fn is_daemon_online() -> bool {
    DAEMON_ONLINE.load(Ordering::Relaxed)
}

// --- Daemon state ---

#[cfg(desktop)]
pub static DAEMON_ONLINE: AtomicBool = AtomicBool::new(false);

#[cfg(desktop)]
static DAEMON_STARTED_BY_US: AtomicBool = AtomicBool::new(false);

#[cfg(desktop)]
static UPDATE_AVAILABLE_VERSION: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

#[cfg(desktop)]
static UPDATE_IN_PROGRESS: AtomicBool = AtomicBool::new(false);

// --- System tray ---

#[cfg(desktop)]
pub fn setup_tray(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::{
        image::Image,
        menu::{MenuBuilder, MenuItemBuilder},
        tray::TrayIconBuilder,
    };

    let show = MenuItemBuilder::with_id("show", "Show").build(app)?;
    let version = MenuItemBuilder::with_id("version", format!("Version {}", app.package_info().version)).enabled(false).build(app)?;
    let update_item = MenuItemBuilder::with_id("update", "Check for Updates").build(app)?;
    let quit = MenuItemBuilder::with_id("quit", "Quit").build(app)?;

    let menu = MenuBuilder::new(app)
        .item(&show)
        .separator()
        .item(&version)
        .item(&update_item)
        .separator()
        .item(&quit)
        .build()?;

    let tray = TrayIconBuilder::new()
        .icon(Image::from_bytes(include_bytes!("../icons/tray-default.png"))
            .expect("tray icon"))
        .icon_as_template(true)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("Alook")
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "show" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
            }
            "update" => {
                let handle = app.clone();
                tauri::async_runtime::spawn(async move {
                    do_install_update(&handle).await;
                });
            }
            "quit" => {
                let handle = app.clone();
                quit_with_daemon_prompt(&handle);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let tauri::tray::TrayIconEvent::Click {
                button: tauri::tray::MouseButton::Left, ..
            } = event {
                if let Some(window) = tray.app_handle().get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
            }
        })
        .build(app)?;

    let handle = app.handle().clone();
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(std::time::Duration::from_secs(15));
            let h = handle.clone();
            let online = tauri::async_runtime::block_on(check_daemon_online(&h));
            DAEMON_ONLINE.store(online, Ordering::Relaxed);
            let icon_bytes: &[u8] = if online {
                include_bytes!("../icons/tray-online.png")
            } else {
                include_bytes!("../icons/tray-offline.png")
            };
            if let Ok(img) = tauri::image::Image::from_bytes(icon_bytes) {
                let _ = tray.set_icon(Some(img));
                let _ = tray.set_icon_as_template(true);
            }
        }
    });

    Ok(())
}

// --- Quit with daemon prompt ---

#[cfg(desktop)]
fn quit_with_daemon_prompt(handle: &AppHandle) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

    if !DAEMON_STARTED_BY_US.load(Ordering::Relaxed) {
        handle.exit(0);
        return;
    }

    let h = handle.clone();
    handle.dialog()
        .message("The Alook daemon is running in the background.\n\nWould you like to keep it running after quitting?")
        .title("Quit Alook")
        .buttons(MessageDialogButtons::OkCancelCustom("Keep Running".into(), "Stop & Quit".into()))
        .show(move |keep_running| {
            if !keep_running {
                let h2 = h.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = run_cli(&h2, &["daemon", "stop"]).await;
                    h2.exit(0);
                });
            } else {
                h.exit(0);
            }
        });
}

// --- Update flow ---

#[cfg(desktop)]
async fn do_install_update(handle: &AppHandle) {
    use tauri_plugin_updater::UpdaterExt;
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
    use tauri::Emitter;

    if UPDATE_IN_PROGRESS.swap(true, Ordering::SeqCst) {
        handle.dialog()
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
            handle.dialog()
                .message(&format!("Could not check for updates: {}", e))
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
                format!("Version {} is available.\n\n{}\n\nDownload and install?", version, notes)
            };

            let (tx, rx) = std::sync::mpsc::channel();
            handle.dialog()
                .message(&msg)
                .title("Update Available")
                .buttons(MessageDialogButtons::OkCancelCustom("Update".into(), "Later".into()))
                .show(move |confirmed| {
                    let _ = tx.send(confirmed);
                });

            let confirmed = rx.recv().unwrap_or(false);
            if !confirmed {
                UPDATE_IN_PROGRESS.store(false, Ordering::SeqCst);
                return;
            }

            let _ = handle.notification()
                .builder()
                .title("Alook")
                .body(&format!("Downloading v{}...", version))
                .show();

            let h = handle.clone();
            let mut cumulative: u64 = 0;
            let result = update.download_and_install(
                move |chunk_size, total| {
                    cumulative += chunk_size as u64;
                    let percent = total.map(|t| (cumulative as f64 / t as f64) * 100.0).unwrap_or(0.0);
                    let _ = h.emit("update://progress", UpdateProgress {
                        percent,
                        downloaded: cumulative,
                        total,
                    });
                },
                || {},
            ).await;

            match result {
                Ok(_) => {
                    let (tx2, rx2) = std::sync::mpsc::channel();
                    handle.dialog()
                        .message(&format!("Version {} has been installed. Restart now?", version))
                        .title("Update Complete")
                        .buttons(MessageDialogButtons::OkCancelCustom("Restart".into(), "Later".into()))
                        .show(move |restart| {
                            let _ = tx2.send(restart);
                        });

                    if rx2.recv().unwrap_or(false) {
                        handle.restart();
                    } else {
                        UPDATE_IN_PROGRESS.store(false, Ordering::SeqCst);
                    }
                }
                Err(e) => {
                    UPDATE_IN_PROGRESS.store(false, Ordering::SeqCst);
                    handle.dialog()
                        .message(&format!("Download failed: {}", e))
                        .title("Update Failed")
                        .buttons(MessageDialogButtons::OkCustom("OK".into()))
                        .show(|_| {});
                }
            }
        }
        Ok(None) => {
            UPDATE_IN_PROGRESS.store(false, Ordering::SeqCst);
            handle.dialog()
                .message("You're on the latest version.")
                .title("No Updates Available")
                .buttons(MessageDialogButtons::OkCustom("OK".into()))
                .show(|_| {});
        }
        Err(e) => {
            UPDATE_IN_PROGRESS.store(false, Ordering::SeqCst);
            handle.dialog()
                .message(&format!("Could not check for updates: {}", e))
                .title("Update Check Failed")
                .buttons(MessageDialogButtons::OkCustom("OK".into()))
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
                let mut guard = UPDATE_AVAILABLE_VERSION.lock().unwrap_or_else(|e| e.into_inner());
                let already_notified = guard.as_deref() == Some(&*version);
                if !already_notified {
                    *guard = Some(version.clone());
                    drop(guard);
                    let _ = handle.notification()
                        .builder()
                        .title("Alook Update Available")
                        .body(&format!("Version {} is ready to install. Use the tray menu to update.", version))
                        .show();
                }
            }

            std::thread::sleep(interval);
        }
    });
}

// --- Daemon helpers ---

#[cfg(desktop)]
async fn check_daemon_online(handle: &AppHandle) -> bool {
    match run_cli(handle, &["daemon", "status"]).await {
        Ok(output) => parse_daemon_status(&output.stdout).running,
        Err(_) => false,
    }
}

#[cfg(desktop)]
pub fn auto_start_daemon(handle: AppHandle) {
    tauri::async_runtime::spawn(async move {
        if check_daemon_online(&handle).await {
            return;
        }

        match run_cli(&handle, &["daemon", "start"]).await {
            Ok(output) if output.success => {
                DAEMON_STARTED_BY_US.store(true, Ordering::Relaxed);
            }
            Ok(output) => {
                let msg = if output.stderr.trim().is_empty() {
                    "Failed to start daemon. Please start it manually with: npx @alook/cli daemon start".to_string()
                } else {
                    format!("Failed to start daemon: {}", output.stderr.trim())
                };
                let _ = handle.notification()
                    .builder()
                    .title("Alook")
                    .body(&msg)
                    .show();
            }
            Err(e) => {
                let _ = handle.notification()
                    .builder()
                    .title("Alook")
                    .body(&format!("Could not find CLI to start daemon: {}", e))
                    .show();
            }
        }
    });
}

#[cfg(desktop)]
pub fn stop_daemon_blocking(handle: &AppHandle) {
    if DAEMON_STARTED_BY_US.load(Ordering::Relaxed) {
        tauri::async_runtime::block_on(async {
            let _ = run_cli(handle, &["daemon", "stop"]).await;
        });
    }
}

pub fn parse_daemon_status(stdout: &str) -> DaemonStatusResult {
    if let Ok(json) = serde_json::from_str::<serde_json::Value>(stdout) {
        return DaemonStatusResult {
            running: json["running"].as_bool().unwrap_or(false),
            pid: json["pid"].as_u64().map(|p| p as u32),
            version: json["version"].as_str().map(|s| s.to_string()),
        };
    }

    let running = stdout.contains("running (pid=");
    let pid = if running {
        stdout
            .split("pid=")
            .nth(1)
            .and_then(|s| s.trim_end_matches(')').trim().parse::<u32>().ok())
    } else {
        None
    };

    DaemonStatusResult {
        running,
        pid,
        version: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_status_json_running() {
        let input = r#"{"running":true,"pid":12345,"version":"0.1.0"}"#;
        let result = parse_daemon_status(input);
        assert!(result.running);
        assert_eq!(result.pid, Some(12345));
        assert_eq!(result.version.as_deref(), Some("0.1.0"));
    }

    #[test]
    fn parse_status_json_not_running() {
        let input = r#"{"running":false,"pid":null,"version":null}"#;
        let result = parse_daemon_status(input);
        assert!(!result.running);
        assert_eq!(result.pid, None);
        assert_eq!(result.version, None);
    }

    #[test]
    fn parse_status_text_running() {
        let input = "Daemon running (pid=54321)";
        let result = parse_daemon_status(input);
        assert!(result.running);
        assert_eq!(result.pid, Some(54321));
        assert_eq!(result.version, None);
    }

    #[test]
    fn parse_status_text_not_running() {
        let input = "Daemon not running.";
        let result = parse_daemon_status(input);
        assert!(!result.running);
        assert_eq!(result.pid, None);
    }

    #[test]
    fn parse_status_empty_string() {
        let result = parse_daemon_status("");
        assert!(!result.running);
        assert_eq!(result.pid, None);
        assert_eq!(result.version, None);
    }

    #[test]
    fn cli_config_args_construction() {
        let cfg = cli_config();
        let mut args: Vec<&str> = cfg.base_args.to_vec();
        args.extend_from_slice(&["register", "--token"]);

        if cfg!(debug_assertions) {
            assert_eq!(cfg.command, "pnpm");
            assert_eq!(args, vec!["dev:cli", "register", "--token"]);
            assert!(cfg.cwd.is_some());
        } else {
            assert_eq!(cfg.command, "npx");
            assert_eq!(args, vec!["@alook/cli", "register", "--token"]);
            assert!(cfg.cwd.is_none());
        }
    }

    #[test]
    fn cli_config_daemon_start_args() {
        let cfg = cli_config();
        let mut args: Vec<&str> = cfg.base_args.to_vec();
        args.extend_from_slice(&["daemon", "start"]);

        if cfg!(debug_assertions) {
            assert_eq!(args, vec!["dev:cli", "daemon", "start"]);
        } else {
            assert_eq!(args, vec!["@alook/cli", "daemon", "start"]);
        }
    }

    #[test]
    fn cli_config_daemon_status_args() {
        let cfg = cli_config();
        let mut args: Vec<&str> = cfg.base_args.to_vec();
        args.extend_from_slice(&["daemon", "status"]);

        if cfg!(debug_assertions) {
            assert_eq!(args, vec!["dev:cli", "daemon", "status"]);
        } else {
            assert_eq!(args, vec!["@alook/cli", "daemon", "status"]);
        }
    }

    #[test]
    fn cli_config_version_args() {
        let cfg = cli_config();
        let mut args: Vec<&str> = cfg.base_args.to_vec();
        args.push("--version");

        if cfg!(debug_assertions) {
            assert_eq!(args, vec!["dev:cli", "--version"]);
        } else {
            assert_eq!(args, vec!["@alook/cli", "--version"]);
        }
    }
}
