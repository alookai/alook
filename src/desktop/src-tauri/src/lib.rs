mod commands;

#[cfg(target_os = "macos")]
mod macos_window;

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
            .plugin(tauri_plugin_updater::Builder::new().build())
            .plugin(tauri_plugin_dialog::init());
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
            commands::get_cli_info,
            commands::register_cli,
            commands::daemon_start,
            commands::daemon_stop,
            commands::daemon_status,
            commands::cli_update,
            commands::cli_check,
            commands::check_for_updates,
            commands::install_update,
            commands::set_window_theme,
            commands::is_daemon_online,
            commands::close_splashscreen,
        ]);
    }

    // System tray + window setup (desktop only)
    #[cfg(desktop)]
    {
        builder = builder.setup(|app| {
            commands::setup_tray(app)?;
            commands::auto_start_daemon(app.handle().clone());
            commands::auto_check_updates(app.handle().clone());

            // Auto-close splash after 5s safety timeout
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(5));
                commands::do_close_splashscreen(&handle);
            });

            // macOS: inset the webview with rounded corners, window bg as frame
            #[cfg(target_os = "macos")]
            {
                use tauri::Manager;
                if let Some(window) = app.get_webview_window("main") {
                    commands::set_window_theme(window.clone(), false);
                    macos_window::setup_inset_webview(&window);
                }
            }

            Ok(())
        });

        builder = builder.on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        });
    }

    let app = builder
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    #[cfg(desktop)]
    {
        let handle = app.handle().clone();
        app.run(move |_app, event| {
            if let tauri::RunEvent::Exit = event {
                commands::stop_daemon_blocking(&handle);
            }
        });
    }

    #[cfg(not(desktop))]
    {
        app.run(|_, _| {});
    }
}
