import { existsSync, readFileSync, readdirSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const root = resolve(import.meta.dirname, "../..")
const tauriRoot = resolve(root, "src/desktop/src-tauri")
const pluginRoot = resolve(tauriRoot, "plugins/mobile-push")
const readRoot = (path: string) => readFileSync(resolve(root, path), "utf8")
const readTauri = (path: string) => readFileSync(resolve(tauriRoot, path), "utf8")
const readPlugin = (path: string) => readFileSync(resolve(pluginRoot, path), "utf8")

type Capability = {
  identifier: string
  windows: string[]
  platforms: string[]
  local: boolean
  remote: { urls: string[] }
  permissions: string[]
}

const commands = [
  "mobile_system_notification_check_permission",
  "mobile_system_notification_request_permission",
  "mobile_system_notification_snapshot",
  "mobile_system_notification_acknowledge_registration",
  "mobile_system_notification_take_activation",
  "mobile_system_notification_listen",
  "mobile_system_notification_unlisten",
]
const production = JSON.parse(readTauri("tauri.conf.json")) as {
  app: { security: { capabilities: string[] } }
}
const development = JSON.parse(readTauri("tauri.dev.conf.json")) as {
  app: { security: { capabilities: Array<string | Capability> } }
}
const capability = JSON.parse(
  readTauri("capabilities/mobile-system-notification-mobile.json"),
) as Capability
const permission = readTauri("permissions/mobile-system-notification.toml")
const build = readTauri("build.rs")
const cargo = readTauri("Cargo.toml")
const rustEntry = readTauri("src/lib.rs")
const runtime = readTauri("src/mobile_system_notification_runtime.rs")
const androidManifest = readPlugin("android/src/main/AndroidManifest.xml")
const androidBuild = readPlugin("android/build.gradle.kts")
const androidAppBuild = readTauri("gen/android/app/build.gradle.kts")
const androidRootBuild = readTauri("gen/android/build.gradle.kts")
const androidStore = readPlugin(
  "android/src/main/java/ai/alook/plugin/mobilepush/MobilePushStore.kt",
)
const androidService = readPlugin(
  "android/src/main/java/ai/alook/plugin/mobilepush/AlookFirebaseMessagingService.kt",
)
const androidPlugin = readPlugin(
  "android/src/main/java/ai/alook/plugin/mobilepush/MobilePushPlugin.kt",
)
const iosPlugin = readPlugin("ios/Sources/MobilePushPlugin.swift")
const iosProject = readTauri("gen/apple/project.yml")
const iosEntitlements = readTauri(
  "gen/apple/alook-desktop_iOS/alook-desktop_iOS.entitlements",
)
const mobileRelease = readRoot(".github/workflows/mobile-release.yml")

describe("mobile system notification contract", () => {
  it("grants only the guarded seven-command API to trusted mobile WebViews", () => {
    const expected = {
      windows: ["main"],
      platforms: ["android", "iOS"],
      remote: { urls: ["https://alook.ai"] },
      local: false,
      permissions: ["mobile-system-notification"],
    }
    expect(production.app.security.capabilities).toContain("mobile-system-notification-mobile")
    expect(capability).toMatchObject(expected)
    const dev = development.app.security.capabilities.find(
      value => typeof value !== "string"
        && value.identifier === "mobile-system-notification-dev",
    )
    expect(dev).toMatchObject({
      ...expected,
      identifier: "mobile-system-notification-dev",
      local: true,
      remote: { urls: ["http://localhost:3000"] },
    })
    for (const command of commands) {
      expect(build).toContain(`"${command}"`)
      expect(permission).toContain(command)
      expect(rustEntry).toContain(`mobile_system_notification_runtime::${command}`)
      const commandSource = runtime.slice(runtime.indexOf(`fn ${command}`))
      expect(commandSource.indexOf("guard(&window)")).toBeGreaterThan(0)
      expect(commandSource.indexOf("guard(&window)")).toBeLessThan(
        commandSource.indexOf(".mobile_push()"),
      )
    }
    for (const item of [capability, dev as Capability]) {
      expect(item.permissions).not.toEqual(expect.arrayContaining([
        expect.stringMatching(/^(?:core:default$|core:event:|deep-link:|store:)/),
      ]))
    }
  })

  it("registers the private plugin on mobile and keeps provider state native", () => {
    expect(cargo).toContain(
      'tauri-plugin-mobile-push = { path = "plugins/mobile-push" }',
    )
    expect(rustEntry).toContain(".plugin(tauri_plugin_mobile_push::init())")
    expect(readPlugin("build.rs")).toContain('"snapshot"')
    expect(readPlugin("build.rs")).toContain('"acknowledgeRegistration"')
    expect(readPlugin("build.rs")).toContain('"takeActivation"')
    const webAdapter = readRoot(
      "src/web/src/lib/community/mobile-system-notification.ts",
    )
    expect(webAdapter).not.toMatch(/(?:localStorage|indexedDB|console\.)/)
    expect(webAdapter).toContain('credentials: "same-origin"')
    expect(webAdapter).toContain('"mobile_system_notification_acknowledge_registration"')
  })

  it("locks Android FCM delivery, durable state, and credential-free builds", () => {
    expect(androidManifest).toContain("android.permission.POST_NOTIFICATIONS")
    expect(androidManifest).toContain("com.google.firebase.MESSAGING_EVENT")
    expect(androidManifest).toContain('android:exported="false"')
    expect(androidManifest).toContain('android:value="alook_messages"')
    expect(androidBuild).toContain("com.google.firebase:firebase-bom:34.19.0")
    expect(androidBuild).toContain("com.google.firebase:firebase-messaging")
    expect(androidBuild).not.toContain("firebase-messaging-ktx")
    expect(androidRootBuild).toContain("com.google.gms:google-services:4.5.0")
    expect(androidAppBuild).toContain('file("google-services.json").exists()')
    expect(readRoot(".gitignore")).toContain(
      "src/desktop/src-tauri/gen/android/app/google-services.json",
    )
    expect(existsSync(resolve(tauriRoot, "gen/android/app/google-services.json"))).toBe(false)
    expect(androidStore).toContain("Context.MODE_PRIVATE")
    expect(androidStore).toContain("acknowledgedToken")
    expect(androidService).toContain("override fun onNewToken")
    expect(androidService).toContain("override fun onMessageReceived")
    expect(androidService).toContain("FLAG_ACTIVITY_SINGLE_TOP")
    expect(androidService).toContain("setContentIntent")
    expect(androidPlugin).toContain("override fun onNewIntent")
  })

  it("locks iOS APNs callbacks, foreground/tap handling, and production entitlement", () => {
    expect(iosPlugin).toContain("registerForRemoteNotifications()")
    expect(iosPlugin).toContain("didRegisterForRemoteNotificationsWithDeviceToken")
    expect(iosPlugin).toContain("didFailToRegisterForRemoteNotificationsWithError")
    expect(iosPlugin).toContain("willPresent notification")
    expect(iosPlugin).toContain("didReceive response")
    expect(iosPlugin).toContain("UIApplication.didBecomeActiveNotification")
    expect(iosPlugin).toContain("MobilePushStore")
    expect(iosProject).toContain("aps-environment: $(APS_ENVIRONMENT)")
    expect(iosProject).toContain("APS_ENVIRONMENT: development")
    expect(iosProject).toContain("APS_ENVIRONMENT: production")
    expect(iosEntitlements).toContain("<key>aps-environment</key>")
    expect(mobileRelease).toContain(
      'assert entitlements["aps-environment"] == "production"',
    )
  })

  it("installs the iOS notification delegate synchronously before deferred app work", () => {
    const initializer = iosPlugin.slice(
      iosPlugin.indexOf("override init()"),
      iosPlugin.indexOf("\n  deinit"),
    )
    const delegateAssignment = initializer.indexOf(
      "UNUserNotificationCenter.current().delegate = bridge.notificationHandler",
    )
    const deferredMainWork = initializer.indexOf("DispatchQueue.main.async {")
    expect(delegateAssignment).toBeGreaterThan(0)
    expect(deferredMainWork).toBeGreaterThan(delegateAssignment)
    const deferred = initializer.slice(deferredMainWork)
    expect(deferred).toContain("MobilePushDelegateHooks.install()")
    expect(deferred).toContain("UIApplication.shared.registerForRemoteNotifications()")
  })

  it("keeps flat route data and provider tokens out of native logs", () => {
    const nativeSources = [
      ...readdirSync(resolve(pluginRoot, "android/src/main/java/ai/alook/plugin/mobilepush"))
        .filter(name => name.endsWith(".kt"))
        .map(name => readPlugin(`android/src/main/java/ai/alook/plugin/mobilepush/${name}`)),
      iosPlugin,
    ].join("\n")
    for (const field of ["notificationId", "messageId", "targetId"]) {
      expect(nativeSources).toContain(field)
    }
    expect(nativeSources).not.toMatch(/\b(?:Log\.[a-z]|print(?:ln)?\s*\()/)
    expect(nativeSources).not.toMatch(/(?:deepLink|serverId|channelId|messageContent)/)
  })
})
