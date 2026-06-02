mod commands;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    // Desktop-only plugins
    #[cfg(desktop)]
    {
        builder = builder
            .plugin(tauri_plugin_shell::init())
            .plugin(tauri_plugin_autostart::init(
                tauri_plugin_autostart::MacosLauncher::LaunchAgent,
                None,
            ))
            .plugin(tauri_plugin_global_shortcut::Builder::new().build())
            .plugin(tauri_plugin_updater::Builder::new().build());
    }

    // Mobile-only plugins
    #[cfg(mobile)]
    {
        builder = builder.plugin(tauri_plugin_biometric::init());
    }

    // Cross-platform plugins
    builder = builder
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_notification::init());

    // Register IPC commands (desktop only)
    #[cfg(desktop)]
    {
        builder = builder.invoke_handler(tauri::generate_handler![
            commands::register_cli,
            commands::daemon_start,
            commands::daemon_stop,
            commands::daemon_status,
            commands::cli_update,
            commands::cli_check,
        ]);
    }

    // System tray (desktop only)
    #[cfg(desktop)]
    {
        builder = builder.setup(|app| {
            commands::setup_tray(app)?;
            commands::auto_start_daemon(app.handle().clone());
            Ok(())
        });
    }

    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
