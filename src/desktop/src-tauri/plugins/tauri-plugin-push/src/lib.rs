use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

mod commands;

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("push")
        .invoke_handler(tauri::generate_handler![
            commands::get_token,
            commands::on_notification,
        ])
        .build()
}
