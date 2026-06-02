use serde::Serialize;
use tauri::{AppHandle, Manager};

#[cfg(desktop)]
use tauri_plugin_shell::ShellExt;

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
#[tauri::command]
pub async fn register_cli(app: AppHandle, token: String) -> Result<CommandResult, String> {
    let output = app
        .shell()
        .command("npx")
        .args(["@alook/cli", "register", "--token", &token])
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
    let output = app
        .shell()
        .command("npx")
        .args(["@alook/cli", "daemon", "start"])
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
    let output = app
        .shell()
        .command("npx")
        .args(["@alook/cli", "daemon", "stop"])
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
    let output = app
        .shell()
        .command("npx")
        .args(["@alook/cli", "daemon", "status", "--json"])
        .output()
        .await
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Ok(DaemonStatusResult {
            running: false,
            pid: None,
            version: None,
        });
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let json: serde_json::Value = serde_json::from_str(&stdout).unwrap_or_default();

    Ok(DaemonStatusResult {
        running: json["running"].as_bool().unwrap_or(false),
        pid: json["pid"].as_u64().map(|p| p as u32),
        version: json["version"].as_str().map(|s| s.to_string()),
    })
}

#[cfg(desktop)]
#[tauri::command]
pub async fn cli_update(app: AppHandle) -> Result<CommandResult, String> {
    // Stop existing daemon first
    let _ = app
        .shell()
        .command("npx")
        .args(["@alook/cli", "daemon", "stop"])
        .output()
        .await;

    // Clear npx cache and install latest CLI
    let install_output = app
        .shell()
        .command("npm")
        .args(["install", "-g", "@alook/cli@latest"])
        .output()
        .await
        .map_err(|e| e.to_string())?;

    if !install_output.status.success() {
        return Ok(CommandResult {
            success: false,
            message: format!(
                "Failed to install latest CLI: {}",
                String::from_utf8_lossy(&install_output.stderr)
            ),
        });
    }

    // Restart daemon with updated CLI
    let start_output = app
        .shell()
        .command("npx")
        .args(["@alook/cli", "daemon", "start"])
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
    let output = app
        .shell()
        .command("npx")
        .args(["@alook/cli", "--version"])
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
        let output = shell
            .command("npx")
            .args(["@alook/cli", "daemon", "status", "--json"])
            .output()
            .await;

        if let Ok(output) = output {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let json: serde_json::Value = serde_json::from_str(&stdout).unwrap_or_default();
            let running = json["running"].as_bool().unwrap_or(false);

            if !running {
                let _ = shell
                    .command("npx")
                    .args(["@alook/cli", "daemon", "start"])
                    .output()
                    .await;
            }
        }
    });
}
