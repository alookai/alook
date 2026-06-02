const COMMANDS: &[&str] = &["get_token", "on_notification"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).build();
}
