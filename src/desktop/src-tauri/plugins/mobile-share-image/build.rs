fn main() {
    tauri_plugin::Builder::new(&[])
        .android_path("android")
        .ios_path("ios")
        .try_build()
        .expect("failed to build mobile share image plugin");
}
