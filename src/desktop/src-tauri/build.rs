fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "daemon_runtime_capability",
            "daemon_pair",
            "set_window_theme",
            "close_splashscreen",
            "desktop_zoom_shortcut",
            "desktop_system_notification_show",
            "desktop_system_notification_listen",
            "desktop_system_notification_take_activation",
            "desktop_system_notification_unlisten",
            "mobile_share_image_copy",
            "mobile_share_image_save",
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
