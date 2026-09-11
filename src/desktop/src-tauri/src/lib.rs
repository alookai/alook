mod commands;

use tauri::Manager;

mod mobile_share_image;
#[cfg(mobile)]
mod mobile_share_image_runtime;
mod native_command_guard;
mod native_oauth;
mod native_oauth_runtime;
mod webview_recovery;

#[cfg(desktop)]
mod updater;

#[cfg(desktop)]
mod zoom;

#[cfg(target_os = "macos")]
mod macos_window;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = webview_recovery::register_protocol(tauri::Builder::default());
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
        commands::show_main_window(app);
    }));
    let builder = builder
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_opener::init());

    // Desktop-only plugins
    #[cfg(desktop)]
    {
        let builder = builder
            .manage(zoom::ZoomState::default())
            .manage(updater::UpdatePromptState::default())
            .append_invoke_initialization_script(zoom::shortcut_script(std::env::consts::OS))
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
    run_mobile(builder);
}

#[cfg(not(desktop))]
fn run_mobile(mut builder: tauri::Builder<tauri::Wry>) {
    builder = builder
        .manage(mobile_share_image::MobileShareImageState::default())
        .plugin(tauri_plugin_mobile_share_image::init());
    builder = builder.invoke_handler(tauri::generate_handler![
        mobile_share_image_runtime::mobile_share_image_copy,
        mobile_share_image_runtime::mobile_share_image_save,
        native_oauth_runtime::native_oauth_snapshot,
        native_oauth_runtime::native_oauth_listen,
        native_oauth_runtime::native_oauth_unlisten,
        native_oauth_runtime::native_oauth_prepare,
        native_oauth_runtime::native_oauth_open_start,
        native_oauth_runtime::native_oauth_pending_exchange,
        native_oauth_runtime::native_oauth_reject_candidate,
        native_oauth_runtime::native_oauth_finish,
        native_oauth_runtime::native_oauth_cancel,
    ]);

    builder = builder.setup(|app| {
        if let Some(window) = app.get_webview_window("main") {
            webview_recovery::attach(&window);
        }
        if native_oauth_runtime::setup(app.handle()).is_err() {
            eprintln!("native OAuth storage unavailable");
        }
        Ok(())
    });

    builder = builder.on_page_load(|webview, payload| {
        webview_recovery::on_page_load(webview, payload);
        if webview.label() == "main"
            && matches!(payload.event(), tauri::webview::PageLoadEvent::Started)
        {
            native_oauth_runtime::retire_listener(webview.app_handle());
        }
    });

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
        native_oauth_runtime::native_oauth_snapshot,
        native_oauth_runtime::native_oauth_listen,
        native_oauth_runtime::native_oauth_unlisten,
        native_oauth_runtime::native_oauth_prepare,
        native_oauth_runtime::native_oauth_open_start,
        native_oauth_runtime::native_oauth_pending_exchange,
        native_oauth_runtime::native_oauth_reject_candidate,
        native_oauth_runtime::native_oauth_finish,
        native_oauth_runtime::native_oauth_cancel,
    ]);

    // System tray + window setup (desktop only)
    builder = builder.setup(|app| {
        if let Some(window) = app.get_webview_window("main") {
            webview_recovery::attach(&window);
        }
        if native_oauth_runtime::setup(app.handle()).is_err() {
            eprintln!("native OAuth storage unavailable");
        }
        zoom::restore(app)?;
        commands::setup_tray(app)?;
        updater::auto_check_updates(app.handle().clone());

        // Serve the splash independently through its inline local protocol.
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
            if let Some(window) = app.get_webview_window("main") {
                commands::set_window_theme(window.clone(), false);
                macos_window::setup_inset_webview(&window);
            }
        }

        Ok(())
    });

    builder = builder.on_page_load(|webview, payload| {
        webview_recovery::on_page_load(webview, payload);
        if webview.label() == "main"
            && matches!(payload.event(), tauri::webview::PageLoadEvent::Started)
        {
            native_oauth_runtime::retire_listener(webview.app_handle());
        }
    });

    builder = builder.on_window_event(|window, event| {
        if window.label() == "main" && matches!(event, tauri::WindowEvent::Destroyed) {
            native_oauth_runtime::retire_listener(window.app_handle());
        }
        #[cfg(target_os = "macos")]
        if window.label() == "main"
            && matches!(
                event,
                tauri::WindowEvent::Resized(_) | tauri::WindowEvent::ScaleFactorChanged { .. }
            )
        {
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

    app.run(|app, event| {
        if should_notify_native_oauth(&event) {
            native_oauth_runtime::notify_listener(app);
        }
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Reopen { .. } = event {
            commands::show_main_window(app);
        }
    });
}

fn should_notify_native_oauth(event: &tauri::RunEvent) -> bool {
    let tauri::RunEvent::WindowEvent { label, event, .. } = event else {
        return false;
    };
    if label != "main" {
        return false;
    }

    #[cfg(mobile)]
    {
        matches!(event, tauri::WindowEvent::Resumed)
    }
    #[cfg(desktop)]
    {
        matches!(event, tauri::WindowEvent::Focused(true))
    }
}
