// swift-tools-version:5.3
import PackageDescription

let package = Package(
  name: "tauri-plugin-mobile-orientation",
  platforms: [.iOS(.v14)],
  products: [.library(name: "tauri-plugin-mobile-orientation", type: .static, targets: ["tauri-plugin-mobile-orientation"])],
  dependencies: [.package(name: "Tauri", path: "../.tauri/tauri-api")],
  targets: [.target(
    name: "tauri-plugin-mobile-orientation",
    dependencies: [.byName(name: "Tauri")],
    path: "Sources",
    linkerSettings: [.linkedFramework("UIKit"), .linkedFramework("CoreMotion")]
  ), .testTarget(
    name: "MobileOrientationTests",
    dependencies: [.byName(name: "tauri-plugin-mobile-orientation")],
    path: "Tests/MobileOrientationTests"
  )]
)
