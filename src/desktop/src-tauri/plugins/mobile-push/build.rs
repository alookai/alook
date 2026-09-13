fn main() {
    tauri_plugin::Builder::new(&[
        "snapshot",
        "acknowledgeRegistration",
        "takeActivation",
        "listen",
        "unlisten",
    ])
    .android_path("android")
    .ios_path("ios")
    .try_build()
    .expect("failed to build mobile push plugin");
}
