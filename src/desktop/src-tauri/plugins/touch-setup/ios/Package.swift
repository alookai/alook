// swift-tools-version:5.5
import PackageDescription
let package = Package(
  name: "tauri-plugin-touch-setup",
  platforms: [.iOS(.v14)],
  products: [.library(name: "tauri-plugin-touch-setup", type: .static, targets: ["tauri-plugin-touch-setup"])],
  dependencies: [
    .package(name: "Tauri", path: "../.tauri/tauri-api"),
    .package(url: "https://github.com/espressif/esp-idf-provisioning-ios.git", revision: "b38391a7ca16d846af1700c902c8e87b9c35c33d")
  ],
  targets: [.target(name: "tauri-plugin-touch-setup", dependencies: [.byName(name: "Tauri"), .product(name: "ESPProvision", package: "esp-idf-provisioning-ios")], path: "Sources", linkerSettings: [.linkedFramework("CoreBluetooth"), .linkedFramework("AVFoundation")])]
)
