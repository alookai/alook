const COMMANDS: &[&str] = &["get_token", "on_notification"];

fn main() {
    tauri_plugin_build::Builder::new(COMMANDS).build();
}
