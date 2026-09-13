// swift-tools-version:5.3
import PackageDescription
let package = Package(name: "tauri-plugin-file-save", platforms: [.iOS(.v14)], products: [.library(name: "tauri-plugin-file-save", type: .static, targets: ["tauri-plugin-file-save"])], dependencies: [.package(name: "Tauri", path: "../.tauri/tauri-api")], targets: [.target(name: "tauri-plugin-file-save", dependencies: [.byName(name: "Tauri")], path: "Sources", linkerSettings: [.linkedFramework("UIKit"), .linkedFramework("CryptoKit")])])
