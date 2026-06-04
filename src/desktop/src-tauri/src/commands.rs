use serde::Serialize;
use tauri::{AppHandle, Manager};

#[cfg(desktop)]
use tauri_plugin_shell::ShellExt;

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

    Ok(CommandResult {
        success: output.status.success(),
        message: String::from_utf8_lossy(&output.stdout).to_string(),
    })
}

#[cfg(desktop)]
#[tauri::command]
pub async fn daemon_start(app: AppHandle) -> Result<CommandResult, String> {
    let cfg = cli_config();
    let mut args: Vec<&str> = cfg.base_args.to_vec();
    args.extend_from_slice(&["daemon", "start"]);

    let mut cmd = app.shell().command(cfg.command);
    for (key, val) in &cfg.env {
        cmd = cmd.env(key, val);
    }
    if let Some(cwd) = &cfg.cwd {
        cmd = cmd.current_dir(cwd.clone());
    }
    let output = cmd
        .args(&args)
        .output()
        .await
        .map_err(|e| e.to_string())?;

    Ok(CommandResult {
        success: output.status.success(),
        message: String::from_utf8_lossy(&output.stdout).to_string(),
    })
}

#[cfg(desktop)]
#[tauri::command]
pub async fn daemon_stop(app: AppHandle) -> Result<CommandResult, String> {
    let cfg = cli_config();
    let mut args: Vec<&str> = cfg.base_args.to_vec();
    args.extend_from_slice(&["daemon", "stop"]);

    let mut cmd = app.shell().command(cfg.command);
    for (key, val) in &cfg.env {
        cmd = cmd.env(key, val);
    }
    if let Some(cwd) = &cfg.cwd {
        cmd = cmd.current_dir(cwd.clone());
    }
    let output = cmd
        .args(&args)
        .output()
        .await
        .map_err(|e| e.to_string())?;

    Ok(CommandResult {
        success: output.status.success(),
        message: String::from_utf8_lossy(&output.stdout).to_string(),
    })
}

#[cfg(desktop)]
#[tauri::command]
pub async fn daemon_status(app: AppHandle) -> Result<DaemonStatusResult, String> {
    let cfg = cli_config();
    let mut args: Vec<&str> = cfg.base_args.to_vec();
    args.extend_from_slice(&["daemon", "status"]);

    let mut cmd = app.shell().command(cfg.command);
    for (key, val) in &cfg.env {
        cmd = cmd.env(key, val);
    }
    if let Some(cwd) = &cfg.cwd {
        cmd = cmd.current_dir(cwd.clone());
    }
    let output = cmd
        .args(&args)
        .output()
        .await
        .map_err(|e| e.to_string())?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();

    Ok(parse_daemon_status(&stdout))
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

    let _ = app
        .shell()
        .command("npx")
        .args(["--yes", "@alook/cli", "daemon", "stop"])
        .output()
        .await;

    let start_output = app
        .shell()
        .command("npx")
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
    let cfg = cli_config();
    let mut args: Vec<&str> = cfg.base_args.to_vec();
    args.push("--version");

    let mut cmd = app.shell().command(cfg.command);
    for (key, val) in &cfg.env {
        cmd = cmd.env(key, val);
    }
    if let Some(cwd) = &cfg.cwd {
        cmd = cmd.current_dir(cwd.clone());
    }
    let output = cmd
        .args(&args)
        .output()
        .await
        .map_err(|e| e.to_string())?;

    Ok(CommandResult {
        success: output.status.success(),
        message: String::from_utf8_lossy(&output.stdout).trim().to_string(),
    })
}

#[derive(Serialize)]
pub struct UpdateInfo {
    pub available: bool,
    pub version: Option<String>,
    pub notes: Option<String>,
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
    let updater = app.updater().map_err(|e| e.to_string())?;
    let update = updater.check().await.map_err(|e| e.to_string())?
        .ok_or("No update available".to_string())?;
    update.download_and_install(|_, _| {}, || {}).await.map_err(|e| e.to_string())?;
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
pub static DAEMON_ONLINE: AtomicBool = AtomicBool::new(false);

#[cfg(desktop)]
pub fn setup_tray(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::{
        image::Image,
        menu::{MenuBuilder, MenuItemBuilder},
        tray::TrayIconBuilder,
    };

    let show = MenuItemBuilder::with_id("show", "Show").build(app)?;
    let version = MenuItemBuilder::with_id("version", format!("Version {}", app.package_info().version)).enabled(false).build(app)?;
    let quit = MenuItemBuilder::with_id("quit", "Quit").build(app)?;

    let menu = MenuBuilder::new(app)
        .item(&show)
        .separator()
        .item(&version)
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
            "quit" => {
                let handle = app.clone();
                tauri::async_runtime::spawn(async move {
                    stop_daemon_async(&handle).await;
                    handle.exit(0);
                });
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
            std::thread::sleep(std::time::Duration::from_secs(5));
            let h = handle.clone();
            let online = tauri::async_runtime::block_on(check_daemon_status(&h));
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

#[cfg(desktop)]
async fn exec_daemon_cmd(handle: &AppHandle, subcommand: &[&str]) {
    let shell = handle.shell();
    let cfg = cli_config();
    let mut args: Vec<&str> = cfg.base_args.to_vec();
    args.extend_from_slice(subcommand);
    let mut cmd = shell.command(cfg.command);
    for (key, val) in &cfg.env {
        cmd = cmd.env(key, val);
    }
    if let Some(cwd) = &cfg.cwd {
        cmd = cmd.current_dir(cwd.clone());
    }
    let _ = cmd.args(&args).output().await;
}

#[cfg(desktop)]
async fn check_daemon_status(handle: &AppHandle) -> bool {
    let shell = handle.shell();
    let cfg = cli_config();
    let mut args: Vec<&str> = cfg.base_args.to_vec();
    args.extend_from_slice(&["daemon", "status"]);
    let mut cmd = shell.command(cfg.command);
    for (key, val) in &cfg.env {
        cmd = cmd.env(key, val);
    }
    if let Some(cwd) = &cfg.cwd {
        cmd = cmd.current_dir(cwd.clone());
    }
    match cmd.args(&args).output().await {
        Ok(output) => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            parse_daemon_status(&stdout).running
        }
        Err(_) => false,
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

#[cfg(desktop)]
async fn stop_daemon_async(handle: &AppHandle) {
    exec_daemon_cmd(handle, &["daemon", "stop"]).await;
}

#[cfg(desktop)]
pub fn auto_start_daemon(handle: AppHandle) {
    tauri::async_runtime::spawn(async move {
        if !check_daemon_status(&handle).await {
            exec_daemon_cmd(&handle, &["daemon", "start"]).await;
        }
    });
}

#[cfg(desktop)]
pub fn stop_daemon_blocking(handle: &AppHandle) {
    tauri::async_runtime::block_on(exec_daemon_cmd(handle, &["daemon", "stop"]));
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
