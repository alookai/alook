// swift-tools-version:5.3

import PackageDescription

let package = Package(
  name: "tauri-plugin-mobile-share-image",
  platforms: [.iOS(.v14)],
  products: [
    .library(
      name: "tauri-plugin-mobile-share-image",
      type: .static,
      targets: ["tauri-plugin-mobile-share-image"])
  ],
  dependencies: [
    .package(name: "Tauri", path: "../.tauri/tauri-api")
  ],
  targets: [
    .target(
      name: "tauri-plugin-mobile-share-image",
      dependencies: [.byName(name: "Tauri")],
      path: "Sources",
      linkerSettings: [
        .linkedFramework("ImageIO"),
        .linkedFramework("Photos"),
        .linkedFramework("UIKit"),
        .linkedFramework("UniformTypeIdentifiers"),
      ]),
    .testTarget(
      name: "MobileShareImagePluginTests",
      dependencies: [.byName(name: "tauri-plugin-mobile-share-image")],
      path: "Tests/MobileShareImagePluginTests")
  ]
)
