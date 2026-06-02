use serde::Serialize;
use tauri::{AppHandle, Manager};

#[cfg(desktop)]
use tauri_plugin_shell::ShellExt;

#[cfg(desktop)]
use std::path::PathBuf;

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

    // Try JSON parse first (production CLI supports --json), fall back to text
    if let Ok(json) = serde_json::from_str::<serde_json::Value>(&stdout) {
        return Ok(DaemonStatusResult {
            running: json["running"].as_bool().unwrap_or(false),
            pid: json["pid"].as_u64().map(|p| p as u32),
            version: json["version"].as_str().map(|s| s.to_string()),
        });
    }

    // Text output: "Daemon running (pid=12345)" or "Daemon not running."
    let running = stdout.contains("running (pid=");
    let pid = if running {
        stdout
            .split("pid=")
            .nth(1)
            .and_then(|s| s.trim_end_matches(')').trim().parse::<u32>().ok())
    } else {
        None
    };

    Ok(DaemonStatusResult {
        running,
        pid,
        version: None,
    })
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

#[cfg(desktop)]
pub fn setup_tray(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::{
        image::Image,
        menu::{MenuBuilder, MenuItemBuilder},
        tray::TrayIconBuilder,
    };

    let show = MenuItemBuilder::with_id("show", "Show Alook").build(app)?;
    let status = MenuItemBuilder::with_id("status", "Daemon: checking...").build(app)?;
    let quit = MenuItemBuilder::with_id("quit", "Quit").build(app)?;

    let menu = MenuBuilder::new(app)
        .item(&show)
        .item(&status)
        .separator()
        .item(&quit)
        .build()?;

    let _tray = TrayIconBuilder::new()
        .icon(Image::from_bytes(include_bytes!("../icons/icon.png")).unwrap_or_else(|_| {
            Image::from_bytes(include_bytes!("../icons/tray-default.png"))
                .expect("fallback tray icon")
        }))
        .menu(&menu)
        .tooltip("Alook")
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "show" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            "quit" => {
                app.exit(0);
            }
            _ => {}
        })
        .build(app)?;

    Ok(())
}

#[cfg(desktop)]
pub fn auto_start_daemon(handle: AppHandle) {
    tauri::async_runtime::spawn(async move {
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
        let output = cmd.args(&args).output().await;

        if let Ok(output) = output {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let running = stdout.contains("running (pid=")
                || serde_json::from_str::<serde_json::Value>(&stdout)
                    .ok()
                    .and_then(|j| j["running"].as_bool())
                    .unwrap_or(false);

            if !running {
                let mut start_args: Vec<&str> = cfg.base_args.to_vec();
                start_args.extend_from_slice(&["daemon", "start"]);

                let mut start_cmd = shell.command(cfg.command);
                for (key, val) in &cfg.env {
                    start_cmd = start_cmd.env(key, val);
                }
                if let Some(cwd) = &cfg.cwd {
                    start_cmd = start_cmd.current_dir(cwd.clone());
                }
                let _ = start_cmd.args(&start_args).output().await;
            }
        }
    });
}
