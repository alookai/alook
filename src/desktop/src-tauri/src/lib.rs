mod commands;

#[cfg(desktop)]
mod updater;

#[cfg(desktop)]
mod zoom;

#[cfg(target_os = "macos")]
mod macos_window;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default().plugin(tauri_plugin_opener::init());

    // Desktop-only plugins
    #[cfg(desktop)]
    {
        let builder = builder
            .manage(zoom::ZoomState::default())
            .manage(updater::UpdatePromptState::default())
            .append_invoke_initialization_script(zoom::shortcut_script(std::env::consts::OS))
            .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
                commands::show_main_window(app);
            }))
            .plugin(tauri_plugin_notification::init())
            .plugin(tauri_plugin_updater::Builder::new().build())
            .plugin(tauri_plugin_dialog::init())
            .plugin(tauri_plugin_clipboard_manager::init())
            .menu(|handle| {
                let menu = updater::build_app_menu(handle)?;
                zoom::extend_app_menu(handle, &menu)?;
                Ok(menu)
            })
            .on_menu_event(
                |app, event| match zoom::handle_menu_event(app, event.id().as_ref()) {
                    Ok(true) => {}
                    Ok(false) => {
                        updater::handle_menu_event(app, event.id().as_ref());
                    }
                    Err(error) => eprintln!("desktop zoom failed: {error}"),
                },
            );
        run_desktop(builder);
    }

    #[cfg(not(desktop))]
    run_app(builder);
}

#[cfg(desktop)]
fn run_desktop(mut builder: tauri::Builder<tauri::Wry>) {
    // Register splash:// protocol to serve inline HTML for the splash window
    builder = builder.register_uri_scheme_protocol("splash", |_ctx, _req| {
        let html = commands::splash_html();
        tauri::http::Response::builder()
            .header("content-type", "text/html; charset=utf-8")
            .body(html.into_bytes())
            .unwrap()
    });

    // Register IPC commands (desktop only)
    builder = builder.invoke_handler(tauri::generate_handler![
        commands::daemon_runtime_capability,
        commands::daemon_pair,
        commands::set_window_theme,
        commands::close_splashscreen,
        zoom::desktop_zoom_shortcut,
    ]);

    // System tray + window setup (desktop only)
    builder = builder.setup(|app| {
        zoom::restore(app)?;
        commands::setup_tray(app)?;
        updater::auto_check_updates(app.handle().clone());

        // Create splash window with inline HTML (frontendDist is remote, so url won't work)
        commands::create_splash_window(app)?;

        // Minimum splash display time (1s) to prevent flash
        let h1 = app.handle().clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(1000));
            commands::mark_splash_min_elapsed(&h1);
        });

        let h2 = app.handle().clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(10));
            commands::mark_splash_max_wait_elapsed(&h2);
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
        #[cfg(target_os = "macos")]
        if window.label() == "main"
            && matches!(
                event,
                tauri::WindowEvent::Resized(_) | tauri::WindowEvent::ScaleFactorChanged { .. }
            )
        {
            use tauri::Manager;
            if let Some(webview) = window.app_handle().get_webview_window("main") {
                macos_window::update_inset_webview(&webview);
            }
        }
        if commands::should_hide_on_close(window.label()) {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        }
    });

    run_app(builder);
}

fn run_app(builder: tauri::Builder<tauri::Wry>) {
    let app = builder
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|_app, _event| {
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Reopen { .. } = _event {
            commands::show_main_window(_app);
        }
    });
}
