#[cfg(desktop)]
use serde::Serialize;
#[cfg(desktop)]
use tauri::{AppHandle, Manager};

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
            command: "npm",
            base_args: &[
                "exec",
                "--yes",
                "--package=@alook/daemon@latest",
                "--",
                "alook-daemon",
            ],
            cwd: None,
        }
    }
}

#[cfg(desktop)]
fn executable_for_platform(command: &str, is_windows: bool) -> String {
    if is_windows && matches!(command, "npm" | "pnpm") {
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
    let args = daemon_argv(&cfg, extra_args);

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
fn daemon_argv(cfg: &DaemonConfig, extra_args: &[String]) -> Vec<String> {
    cfg.base_args
        .iter()
        .map(|arg| (*arg).to_string())
        .chain(extra_args.iter().cloned())
        .collect()
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
fn valid_machine_id(machine_id: &str) -> bool {
    let Some(value) = machine_id.strip_prefix("cm_") else {
        return false;
    };
    (8..=64).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

#[cfg(desktop)]
fn daemon_pair_args(
    machine_key: &str,
    machine_id: Option<&str>,
    is_debug: bool,
) -> Result<Vec<String>, String> {
    if !valid_machine_key(machine_key) {
        return Err("invalid Community machine key".to_string());
    }
    if let Some(machine_id) = machine_id {
        if !machine_key.starts_with("cmt_") || !valid_machine_id(machine_id) {
            return Err("invalid Community reconnect identity".to_string());
        }
    }
    let (server_url, ws_url) = daemon_endpoints_for(is_debug);
    let mut args = vec![
        "daemon".to_string(),
        if machine_id.is_some() {
            "reconnect".to_string()
        } else {
            "start".to_string()
        },
    ];
    if let Some(machine_id) = machine_id {
        args.extend(["--id".to_string(), machine_id.to_string()]);
    }
    args.extend([
        "--machine-key".to_string(),
        machine_key.to_string(),
        "--server-url".to_string(),
        server_url.to_string(),
        "--ws-url".to_string(),
        ws_url.to_string(),
    ]);
    Ok(args)
}

#[cfg(desktop)]
fn evaluate_runtime_capability(
    node: Result<String, String>,
    npm: Result<String, String>,
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
    if let Err(reason) = npm {
        return DaemonRuntimeCapability {
            available: false,
            reason: Some(format!(
                "Node.js is available, but {reason}. Install npm with Node.js and try again."
            )),
            node_version: (!node_output.is_empty()).then_some(node_output),
        };
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
    let (node, npm) = tokio::join!(
        probe_runtime_command("node", path.clone()),
        probe_runtime_command("npm", path),
    );
    evaluate_runtime_capability(node, npm)
}

#[cfg(desktop)]
#[tauri::command]
pub async fn daemon_pair(
    machine_key: String,
    machine_id: Option<String>,
) -> Result<CommandResult, String> {
    let args = daemon_pair_args(&machine_key, machine_id.as_deref(), cfg!(debug_assertions))?;
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
                (1.0f64, 1.0f64, 1.0f64)
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
pub fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[cfg(desktop)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TrayMenuAction {
    Show,
    Quit,
}

#[cfg(desktop)]
fn tray_menu_action(id: &str) -> Option<TrayMenuAction> {
    match id {
        "show" => Some(TrayMenuAction::Show),
        "quit" => Some(TrayMenuAction::Quit),
        _ => None,
    }
}

#[cfg(target_os = "macos")]
const TRAY_ICON_BYTES: &[u8] = include_bytes!("../icons/tray-macos-template.png");
#[cfg(target_os = "macos")]
const TRAY_ICON_IS_TEMPLATE: bool = true;

#[cfg(any(target_os = "windows", target_os = "linux"))]
const TRAY_ICON_BYTES: &[u8] = include_bytes!("../icons/tray-windows-linux-color.png");
#[cfg(any(target_os = "windows", target_os = "linux"))]
const TRAY_ICON_IS_TEMPLATE: bool = false;

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
    let update_item = MenuItemBuilder::with_id(
        crate::updater::CHECK_FOR_UPDATES_MENU_ID,
        "Check for Updates…",
    )
    .build(app)?;
    crate::updater::register_tray_update_item(update_item.clone());
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
        .icon(Image::from_bytes(TRAY_ICON_BYTES).expect("tray icon"))
        .icon_as_template(TRAY_ICON_IS_TEMPLATE)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("Alook")
        .on_menu_event(
            move |app, event| match tray_menu_action(event.id().as_ref()) {
                Some(TrayMenuAction::Show) => show_main_window(app),
                Some(TrayMenuAction::Quit) => {
                    app.exit(0);
                }
                None => {}
            },
        )
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_capability_requires_node_and_npm() {
        let ok = || Ok("10.9.3".to_string());
        let old = evaluate_runtime_capability(Ok("v16.0.0".to_string()), ok());
        assert!(old.available);
        assert_eq!(old.node_version.as_deref(), Some("v16.0.0"));

        let unrecognized = evaluate_runtime_capability(Ok("not-a-version".to_string()), ok());
        assert!(unrecognized.available);

        let missing_npm = evaluate_runtime_capability(
            Ok("v22.0.0".to_string()),
            Err("npm was not found".to_string()),
        );
        assert!(!missing_npm.available);
        assert!(missing_npm.reason.unwrap().contains("npm was not found"));
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
        assert_eq!(release.command, "npm");
        assert_eq!(
            release.base_args,
            &[
                "exec",
                "--yes",
                "--package=@alook/daemon@latest",
                "--",
                "alook-daemon",
            ]
        );
        assert!(release.cwd.is_none());
    }

    #[test]
    fn tray_routes_only_tray_owned_actions() {
        assert_eq!(tray_menu_action("show"), Some(TrayMenuAction::Show));
        assert_eq!(tray_menu_action("quit"), Some(TrayMenuAction::Quit));
        assert_eq!(
            tray_menu_action(crate::updater::CHECK_FOR_UPDATES_MENU_ID),
            None
        );
        assert_eq!(tray_menu_action("unknown"), None);
    }

    #[test]
    fn tray_icon_template_mode_matches_the_current_platform() {
        assert!(!TRAY_ICON_BYTES.is_empty());
        assert_eq!(TRAY_ICON_IS_TEMPLATE, cfg!(target_os = "macos"));
    }

    #[test]
    fn release_pairing_uses_the_exact_published_bin_argv() {
        let key = "cmt_abcdefghijklmnopqrstuvwxyz012345";
        let extra = daemon_pair_args(key, Some("cm_abcdefgh"), false).unwrap();
        let cfg = daemon_config_for(false);
        assert_eq!(
            daemon_argv(&cfg, &extra),
            vec![
                "exec",
                "--yes",
                "--package=@alook/daemon@latest",
                "--",
                "alook-daemon",
                "daemon",
                "reconnect",
                "--id",
                "cm_abcdefgh",
                "--machine-key",
                key,
                "--server-url",
                "https://alook.ai",
                "--ws-url",
                "wss://alook.ai/api/ws/community-daemon",
            ]
        );
    }

    #[test]
    fn windows_uses_command_shims_for_node_package_tools() {
        assert_eq!(executable_for_platform("node", true), "node");
        assert_eq!(executable_for_platform("npm", true), "npm.cmd");
        assert_eq!(executable_for_platform("pnpm", true), "pnpm.cmd");
        assert_eq!(executable_for_platform("npm", false), "npm");
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
            let args = daemon_pair_args(key, None, false).unwrap();
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
            assert!(daemon_pair_args(invalid, None, false).is_err());
        }
    }

    #[test]
    fn reconnect_builds_exact_machine_arguments_and_rejects_invalid_ids() {
        let key = "cmt_abcdefghijklmnopqrstuvwxyz012345";
        let args = daemon_pair_args(key, Some("cm_abcdefgh"), false).unwrap();
        assert_eq!(
            &args[..6],
            [
                "daemon",
                "reconnect",
                "--id",
                "cm_abcdefgh",
                "--machine-key",
                key,
            ]
        );
        assert!(daemon_pair_args(key, Some("bad"), false).is_err());
        assert!(daemon_pair_args(
            "cmk_abcDEF0123456789_-abcdefghijklmn",
            Some("cm_abcdefgh"),
            false,
        )
        .is_err());
    }

    #[test]
    fn development_pairing_uses_only_fixed_local_endpoints() {
        let args = daemon_pair_args("cmt_abcdefghijklmnopqrstuvwxyz012345", None, true).unwrap();
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
