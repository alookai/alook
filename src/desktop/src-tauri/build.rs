fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("ios") {
        println!("cargo:rerun-if-changed=src/startup_log_ios.c");
        let ios_minimum =
            std::env::var("IPHONEOS_DEPLOYMENT_TARGET").unwrap_or_else(|_| "15.0".to_owned());
        cc::Build::new()
            .env("IPHONEOS_DEPLOYMENT_TARGET", ios_minimum)
            .file("src/startup_log_ios.c")
            .compile("alook_startup_log_ios");
    }
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "file_save_begin",
            "file_save_write_chunk",
            "file_save_commit",
            "file_save_cancel",
            "daemon_runtime_capability",
            "daemon_pair",
            "set_window_theme",
            "close_splashscreen",
            "desktop_zoom_shortcut",
            "native_geometry_snapshot",
            "desktop_system_notification_show",
            "desktop_system_notification_listen",
            "desktop_system_notification_take_activation",
            "desktop_system_notification_retry_activation",
            "desktop_system_notification_dismiss",
            "desktop_system_notification_dismiss_conversation",
            "desktop_system_notification_unlisten",
            "mobile_share_image_copy",
            "mobile_share_image_save",
            "mobile_system_notification_check_permission",
            "mobile_system_notification_request_permission",
            "mobile_system_notification_snapshot",
            "mobile_system_notification_acknowledge_registration",
            "mobile_system_notification_take_activation",
            "mobile_system_notification_dismiss",
            "mobile_system_notification_dismiss_conversation",
            "mobile_system_notification_listen",
            "mobile_system_notification_unlisten",
            "native_oauth_snapshot",
            "native_oauth_listen",
            "native_oauth_unlisten",
            "native_oauth_prepare",
            "native_oauth_open_start",
            "native_oauth_pending_exchange",
            "native_oauth_reject_candidate",
            "native_oauth_finish",
            "native_oauth_cancel",
        ]),
    ))
    .expect("failed to build application permissions");
}
