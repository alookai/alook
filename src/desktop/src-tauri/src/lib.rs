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

    // Register splash:// protocol to serve inline HTML for the splash window
    #[cfg(desktop)]
    {
        builder = builder.register_uri_scheme_protocol("splash", |_ctx, _req| {
            let html = commands::splash_html();
            tauri::http::Response::builder()
                .header("content-type", "text/html; charset=utf-8")
                .body(html.into_bytes())
                .unwrap()
        });
    }

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

            // Create splash window with inline HTML (frontendDist is remote, so url won't work)
            commands::create_splash_window(app)?;

            // Minimum splash display time (1s) to prevent flash
            let h1 = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(1000));
                commands::mark_splash_min_elapsed(&h1);
            });

            // Safety timeout: force-close splash after 5s even if frontend never signals
            let h2 = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(5));
                commands::do_close_splashscreen(&h2);
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
