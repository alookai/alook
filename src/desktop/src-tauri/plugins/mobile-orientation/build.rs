fn main() {
    tauri_plugin::Builder::new(&["listen", "unlisten", "retire"])
        .android_path("android")
        .ios_path("ios")
        .try_build()
        .expect("failed to build mobile orientation plugin");
}
