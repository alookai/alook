#[cfg(desktop)]
use serde::Serialize;
#[cfg(desktop)]
use tauri::{AppHandle, Manager};

#[cfg(desktop)]
use tauri_plugin_notification::NotificationExt;

#[cfg(desktop)]
use std::path::PathBuf;

#[cfg(desktop)]
use std::{
    io::Read,
    process::{Command, Stdio},
    time::{Duration, Instant},
};

#[cfg(desktop)]
use command_group::CommandGroup;

#[cfg(desktop)]
use std::sync::atomic::{AtomicBool, Ordering};

#[cfg(desktop)]
const PATH_DISCOVERY_TIMEOUT: Duration = Duration::from_secs(2);

#[cfg(desktop)]
const RUNTIME_PROBE_TIMEOUT: Duration = Duration::from_secs(5);

#[cfg(desktop)]
const DAEMON_PAIR_TIMEOUT: Duration = Duration::from_secs(60);

#[cfg(desktop)]
const UPDATE_CHECK_TIMEOUT: Duration = Duration::from_secs(15);

#[cfg(desktop)]
const UPDATE_DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(10 * 60);

#[derive(Serialize)]
#[cfg(desktop)]
pub struct CommandResult {
    pub success: bool,
    pub message: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[cfg(desktop)]
#[serde(rename_all = "camelCase")]
pub struct DaemonRuntimeCapability {
    pub available: bool,
    pub reason: Option<String>,
    pub node_version: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
#[cfg(desktop)]
struct DaemonConfig {
    command: &'static str,
    base_args: &'static [&'static str],
    cwd: Option<PathBuf>,
}

#[cfg(desktop)]
fn daemon_config() -> DaemonConfig {
    daemon_config_for(cfg!(debug_assertions))
}

#[cfg(desktop)]
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

#[cfg(desktop)]
fn executable_for_platform(command: &str, is_windows: bool) -> String {
    if is_windows && matches!(command, "npm" | "npx" | "pnpm") {
        format!("{command}.cmd")
    } else {
        command.to_string()
    }
}

#[cfg(desktop)]
fn executable(command: &str) -> String {
    executable_for_platform(command, cfg!(windows))
}

#[cfg(desktop)]
fn daemon_endpoints_for(is_debug: bool) -> (&'static str, &'static str) {
    if is_debug {
        ("http://localhost:3000", "ws://localhost:8789")
    } else {
        ("https://alook.ai", "wss://alook.ai/api/ws/community-daemon")
    }
}

#[cfg(desktop)]
#[derive(Debug)]
struct DaemonOutput {
    success: bool,
    stdout: String,
    stderr: String,
}

#[cfg(desktop)]
fn read_process_pipe<R: Read + Send + 'static>(mut pipe: R) -> std::thread::JoinHandle<Vec<u8>> {
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = pipe.read_to_end(&mut bytes);
        bytes
    })
}

#[cfg(desktop)]
fn run_process_with_timeout(
    mut command: Command,
    timeout: Duration,
    timeout_message: String,
) -> Result<DaemonOutput, String> {
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command.group_spawn().map_err(|error| error.to_string())?;
    let stdout = child
        .inner()
        .stdout
        .take()
        .map(read_process_pipe)
        .ok_or("failed to capture process stdout")?;
    let stderr = child
        .inner()
        .stderr
        .take()
        .map(read_process_pipe)
        .ok_or("failed to capture process stderr")?;
    let deadline = Instant::now() + timeout;

    let mut status = None;
    loop {
        if status.is_none() {
            status = child.try_wait().map_err(|error| error.to_string())?;
        }
        if status.is_some() && stdout.is_finished() && stderr.is_finished() {
            break;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            let _ = stdout.join();
            let _ = stderr.join();
            return Err(timeout_message);
        }
        std::thread::sleep(Duration::from_millis(20));
    }

    let stdout = stdout.join().map_err(|_| "stdout reader failed")?;
    let stderr = stderr.join().map_err(|_| "stderr reader failed")?;
    Ok(DaemonOutput {
        success: status.is_some_and(|status| status.success()),
        stdout: String::from_utf8_lossy(&stdout).trim().to_string(),
        stderr: String::from_utf8_lossy(&stderr).trim().to_string(),
    })
}

#[cfg(desktop)]
async fn run_process(
    command: Command,
    timeout: Duration,
    timeout_message: String,
) -> Result<DaemonOutput, String> {
    tauri::async_runtime::spawn_blocking(move || {
        run_process_with_timeout(command, timeout, timeout_message)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(desktop)]
fn parse_shell_path(stdout: &str) -> Option<String> {
    let value = stdout.trim();
    if value.is_empty() || value.lines().count() != 1 {
        return None;
    }
    let paths: Vec<PathBuf> = std::env::split_paths(value).collect();
    if paths.is_empty() || paths.iter().any(|path| !path.is_absolute()) {
        return None;
    }
    Some(value.to_string())
}

#[cfg(desktop)]
async fn resolve_path() -> String {
    let fallback = std::env::var("PATH").unwrap_or_default();
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
    let mut command = Command::new(shell);
    command.args(["-ilc", "printf '%s\\n' \"$PATH\""]);
    match run_process(
        command,
        PATH_DISCOVERY_TIMEOUT,
        "login shell PATH lookup timed out".to_string(),
    )
    .await
    {
        Ok(output) if output.success => parse_shell_path(&output.stdout).unwrap_or(fallback),
        _ => fallback,
    }
}

#[cfg(desktop)]
async fn run_daemon(extra_args: &[String]) -> Result<DaemonOutput, String> {
    let cfg = daemon_config();
    let mut args: Vec<String> = cfg.base_args.iter().map(|arg| (*arg).to_string()).collect();
    args.extend_from_slice(extra_args);

    let mut command = Command::new(executable(cfg.command));
    command.env("PATH", resolve_path().await);
    if let Some(cwd) = &cfg.cwd {
        command.current_dir(cwd);
    }
    command.args(&args);
    run_process(
        command,
        DAEMON_PAIR_TIMEOUT,
        "The daemon didn't start within 60 seconds. Check your network and try again.".to_string(),
    )
    .await
}

#[cfg(desktop)]
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

#[cfg(desktop)]
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

#[cfg(desktop)]
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

#[cfg(desktop)]
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
async fn probe_runtime_command(command: &'static str, path: String) -> Result<String, String> {
    let mut process = Command::new(executable(command));
    process.env("PATH", path).arg("--version");
    let output = run_process(
        process,
        RUNTIME_PROBE_TIMEOUT,
        format!("{command} did not respond within 5 seconds"),
    )
    .await
    .map_err(|error| {
        if error.contains("did not respond") {
            error
        } else {
            format!("{command} was not found")
        }
    })?;
    if !output.success {
        return Err(format!("{command} could not run"));
    }
    Ok(output.stdout)
}

// --- Splashscreen ---

#[cfg(desktop)]
static SPLASH_CLOSED: AtomicBool = AtomicBool::new(false);

#[cfg(desktop)]
static SPLASH_FRONTEND_READY: AtomicBool = AtomicBool::new(false);

#[cfg(desktop)]
static SPLASH_MIN_ELAPSED: AtomicBool = AtomicBool::new(false);

#[cfg(desktop)]
static SPLASH_MAX_WAIT_ELAPSED: AtomicBool = AtomicBool::new(false);

#[cfg(desktop)]
pub fn should_hide_on_close(window_label: &str) -> bool {
    window_label == "main"
}

#[cfg(desktop)]
fn should_close_splash(frontend_ready: bool, min_elapsed: bool, max_wait_elapsed: bool) -> bool {
    max_wait_elapsed || (frontend_ready && min_elapsed)
}

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
    let app = handle.clone();
    let _ = handle.run_on_main_thread(move || {
        if let Some(main) = app.get_webview_window("main") {
            let _ = main.show();
            let _ = main.set_focus();
        }
        if let Some(splash) = app.get_webview_window("splash") {
            let _ = splash.close();
        }
    });
}

#[cfg(desktop)]
fn try_close_splashscreen(handle: &AppHandle) {
    let frontend = SPLASH_FRONTEND_READY.load(Ordering::SeqCst);
    let min = SPLASH_MIN_ELAPSED.load(Ordering::SeqCst);
    let max = SPLASH_MAX_WAIT_ELAPSED.load(Ordering::SeqCst);
    if should_close_splash(frontend, min, max) {
        do_close_splashscreen(handle);
    }
}

#[cfg(desktop)]
pub fn mark_splash_min_elapsed(handle: &AppHandle) {
    SPLASH_MIN_ELAPSED.store(true, Ordering::SeqCst);
    try_close_splashscreen(handle);
}

#[cfg(desktop)]
pub fn mark_splash_max_wait_elapsed(handle: &AppHandle) {
    SPLASH_MAX_WAIT_ELAPSED.store(true, Ordering::SeqCst);
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
pub async fn daemon_runtime_capability() -> DaemonRuntimeCapability {
    let path = resolve_path().await;
    let (node, npm, npx) = tokio::join!(
        probe_runtime_command("node", path.clone()),
        probe_runtime_command("npm", path.clone()),
        probe_runtime_command("npx", path),
    );
    evaluate_runtime_capability(node, npm, npx)
}

#[cfg(desktop)]
#[tauri::command]
pub async fn daemon_pair(machine_key: String) -> Result<CommandResult, String> {
    let args = daemon_pair_args(&machine_key, cfg!(debug_assertions))?;
    let output = run_daemon(&args).await?;
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
#[cfg(desktop)]
struct UpdateProgress {
    percent: f64,
    downloaded: u64,
    total: Option<u64>,
}

#[cfg(desktop)]
#[tauri::command]
pub fn set_window_theme(window: tauri::WebviewWindow, dark: bool) {
    let _ = (&window, dark);
    #[cfg(target_os = "macos")]
    {
        use objc2::msg_send;
        use objc2::runtime::AnyObject;

        let target = window.clone();
        let _ = window.run_on_main_thread(move || unsafe {
            let ns_window = target.ns_window().unwrap() as *mut AnyObject;
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
        });
    }
}

#[cfg(desktop)]
static UPDATE_AVAILABLE_VERSION: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

#[cfg(desktop)]
static UPDATE_IN_PROGRESS: AtomicBool = AtomicBool::new(false);

#[cfg(desktop)]
struct UpdateInProgressGuard<'a> {
    flag: &'a AtomicBool,
}

#[cfg(desktop)]
impl<'a> UpdateInProgressGuard<'a> {
    fn acquire(flag: &'a AtomicBool) -> Option<Self> {
        flag.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .ok()
            .map(|_| Self { flag })
    }
}

#[cfg(desktop)]
impl Drop for UpdateInProgressGuard<'_> {
    fn drop(&mut self) {
        self.flag.store(false, Ordering::SeqCst);
    }
}

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

    let Some(update_guard) = UpdateInProgressGuard::acquire(&UPDATE_IN_PROGRESS) else {
        handle
            .dialog()
            .message("An update is already in progress.")
            .title("Alook")
            .buttons(MessageDialogButtons::OkCustom("OK".into()))
            .show(|_| {});
        return;
    };

    let updater = match handle
        .updater_builder()
        .timeout(UPDATE_CHECK_TIMEOUT)
        .build()
    {
        Ok(u) => u,
        Err(e) => {
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
        Ok(Some(mut update)) => {
            update.timeout = Some(UPDATE_DOWNLOAD_TIMEOUT);
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
                        return;
                    }
                    tauri::async_runtime::spawn(async move {
                        install_checked_update(h, update, update_guard).await;
                    });
                });
        }
        Ok(None) => {
            handle
                .dialog()
                .message("You're on the latest version.")
                .title("No Updates Available")
                .buttons(MessageDialogButtons::OkCustom("OK".into()))
                .show(|_| {});
        }
        Err(e) => {
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
async fn install_checked_update(
    handle: AppHandle,
    update: tauri_plugin_updater::Update,
    update_guard: UpdateInProgressGuard<'static>,
) {
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
                    }
                    drop(update_guard);
                });
        }
        Err(error) => {
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
                let updater = h
                    .updater_builder()
                    .timeout(UPDATE_CHECK_TIMEOUT)
                    .build()
                    .ok()?;
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
    fn windows_uses_command_shims_for_node_package_tools() {
        assert_eq!(executable_for_platform("node", true), "node");
        assert_eq!(executable_for_platform("npm", true), "npm.cmd");
        assert_eq!(executable_for_platform("npx", true), "npx.cmd");
        assert_eq!(executable_for_platform("pnpm", true), "pnpm.cmd");
        assert_eq!(executable_for_platform("npx", false), "npx");
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
            "commands::check_for_updates",
            "commands::install_update",
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

    #[test]
    fn desktop_restores_the_main_window_for_a_second_instance() {
        let app_source = include_str!("lib.rs");
        let single_instance = app_source
            .find("tauri_plugin_single_instance::init")
            .unwrap();
        let updater = app_source.find("tauri_plugin_updater::Builder").unwrap();
        assert!(single_instance < updater);
        assert!(app_source[single_instance..updater].contains("show_main_window(app)"));
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
    fn updater_network_operations_have_explicit_deadlines() {
        let source = include_str!("commands.rs");
        assert_eq!(UPDATE_CHECK_TIMEOUT, Duration::from_secs(15));
        assert_eq!(UPDATE_DOWNLOAD_TIMEOUT, Duration::from_secs(10 * 60));
        assert!(source.matches(".timeout(UPDATE_CHECK_TIMEOUT)").count() >= 2);
        assert!(source.contains("update.timeout = Some(UPDATE_DOWNLOAD_TIMEOUT)"));
    }

    #[test]
    fn close_to_hide_applies_only_to_the_main_window() {
        assert!(should_hide_on_close("main"));
        assert!(!should_hide_on_close("splash"));
        assert!(!should_hide_on_close("settings"));

        let app_source = include_str!("lib.rs");
        assert!(app_source.contains("should_hide_on_close(window.label())"));
    }

    #[test]
    fn splash_closes_when_ready_or_when_the_native_deadline_expires() {
        assert!(!should_close_splash(false, false, false));
        assert!(!should_close_splash(true, false, false));
        assert!(!should_close_splash(false, true, false));
        assert!(should_close_splash(true, true, false));
        assert!(should_close_splash(false, false, true));

        let app_source = include_str!("lib.rs");
        assert!(app_source.contains("Duration::from_secs(10)"));
        assert!(app_source.contains("mark_splash_max_wait_elapsed"));
    }

    #[test]
    fn login_shell_path_accepts_only_one_line_of_absolute_entries() {
        let root = std::env::current_dir().unwrap();
        let first = root.join("runtime-path-one");
        let second = root.join("runtime-path-two");
        let valid = std::env::join_paths([first, second])
            .unwrap()
            .to_string_lossy()
            .to_string();
        assert_eq!(parse_shell_path(&valid).as_deref(), Some(valid.as_str()));
        assert!(parse_shell_path("").is_none());
        assert!(parse_shell_path("banner\n/usr/bin").is_none());
        assert!(parse_shell_path("relative/bin").is_none());
    }

    #[cfg(unix)]
    #[test]
    fn bounded_process_kills_a_stalled_process_group_holding_output_pipes() {
        let mut command = Command::new("sh");
        command.args(["-c", "(sh -c 'sleep 5') &"]);
        let started = Instant::now();
        let error = run_process_with_timeout(
            command,
            Duration::from_millis(50),
            "process timed out".to_string(),
        )
        .unwrap_err();

        assert_eq!(error, "process timed out");
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn desktop_remote_capability_has_no_plugin_permissions_or_localhost() {
        let capability = include_str!("../capabilities/desktop.json");
        assert!(capability.contains("https://alook.ai"));
        assert!(!capability.contains("localhost"));
        for rejected in [
            "shell:",
            "autostart:",
            "global-shortcut:",
            "updater:",
            "dialog:",
            "notification:",
            "deep-link:",
        ] {
            assert!(!capability.contains(rejected));
        }

        let app_source = include_str!("lib.rs");
        let cargo_manifest = include_str!("../Cargo.toml");
        for removed in ["autostart", "global_shortcut", "deep_link"] {
            assert!(!app_source.contains(removed));
            assert!(!cargo_manifest.contains(&removed.replace('_', "-")));
        }
    }

    #[test]
    fn cocoa_mutations_are_dispatched_to_the_main_thread() {
        let command_source = include_str!("commands.rs");
        let window_source = include_str!("macos_window.rs");
        let removed_fade = ["fade", "out", "and", "close", "splash"].join("_");
        assert!(!command_source.contains(&removed_fade));
        assert!(command_source.contains("handle.run_on_main_thread"));
        assert!(command_source.contains("window.run_on_main_thread"));
        assert!(window_source.contains("window.run_on_main_thread"));
    }

    #[test]
    fn mobile_placeholder_plugins_are_not_linked_or_registered() {
        let app_source = include_str!("lib.rs");
        let cargo_manifest = include_str!("../Cargo.toml");
        for removed in ["tauri_plugin_biometric", "tauri_plugin_push"] {
            assert!(!app_source.contains(removed));
            assert!(!cargo_manifest.contains(&removed.replace('_', "-")));
        }
        let common_dependencies = cargo_manifest
            .split("[target.\"cfg(not(any(target_os = \\\"android\\\", target_os = \\\"ios\\\")))\".dependencies]")
            .next()
            .unwrap();
        assert!(!common_dependencies.contains("tauri-plugin-notification"));
        assert!(app_source.contains(".plugin(tauri_plugin_notification::init())"));
    }
}
