import { readFileSync, readdirSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const root = resolve(import.meta.dirname, "../..")
const tauriRoot = resolve(root, "src/desktop/src-tauri")
const pluginRoot = resolve(tauriRoot, "plugins/mobile-share-image")
const readRoot = (file: string) => readFileSync(resolve(root, file), "utf8")
const readTauri = (file: string) => readFileSync(resolve(tauriRoot, file), "utf8")
const readPlugin = (file: string) => readFileSync(resolve(pluginRoot, file), "utf8")

type Capability = {
  identifier: string
  windows: string[]
  platforms: string[]
  local: boolean
  remote: { urls: string[] }
  permissions: string[]
}

const production = JSON.parse(readTauri("tauri.conf.json")) as {
  app: { security: { capabilities: string[] } }
}
const development = JSON.parse(readTauri("tauri.dev.conf.json")) as {
  app: { security: { capabilities: Array<string | Capability> } }
}
const mobileCapability = JSON.parse(
  readTauri("capabilities/mobile-share-image-mobile.json"),
) as Capability
const build = readTauri("build.rs")
const rustEntry = readTauri("src/lib.rs")
const imageRuntime = readTauri("src/mobile_share_image_runtime.rs")
const oauthRuntime = readTauri("src/native_oauth_runtime.rs")
const guard = readTauri("src/native_command_guard.rs")
const appManifest = readTauri("gen/android/app/src/main/AndroidManifest.xml")
const pluginManifest = readPlugin("android/src/main/AndroidManifest.xml")
const providerPaths = readPlugin("android/src/main/res/xml/mobile_share_image_file_paths.xml")
const androidImage = readPlugin(
  "android/src/main/java/ai/alook/plugin/mobileshareimage/MobileShareImage.kt",
)
const androidDocumentOwner = readPlugin(
  "android/src/main/java/ai/alook/plugin/mobileshareimage/MobileShareImageDocumentOwner.kt",
)
const androidDocumentCore = readPlugin(
  "android/src/main/java/ai/alook/plugin/mobileshareimage/MobileShareImageDocumentCoordinatorCore.kt",
)
const androidDocumentResultAdapter = readPlugin(
  "android/src/main/java/ai/alook/plugin/mobileshareimage/MobileShareImageDocumentResultAdapter.kt",
)
const androidClipboardTransaction = readPlugin(
  "android/src/main/java/ai/alook/plugin/mobileshareimage/MobileShareImageClipboardTransaction.kt",
)
const androidPlugin = readPlugin(
  "android/src/main/java/ai/alook/plugin/mobileshareimage/MobileShareImagePlugin.kt",
)
const iosProject = readTauri("gen/apple/project.yml")
const iosPlugin = readPlugin("ios/Sources/MobileShareImagePlugin.swift")

describe("native mobile share-image contract", () => {
  it("grants only both generated commands to the exact mobile production and dev callers", () => {
    const expected = {
      windows: ["main"],
      platforms: ["android", "iOS"],
      remote: { urls: ["https://alook.ai"] },
      local: false,
      permissions: [
        "allow-mobile-share-image-copy",
        "allow-mobile-share-image-save",
      ],
    }
    expect(production.app.security.capabilities).toContain("mobile-share-image-mobile")
    expect(mobileCapability).toMatchObject(expected)

    const dev = development.app.security.capabilities.find(
      capability => typeof capability !== "string"
        && capability.identifier === "mobile-share-image-dev",
    )
    expect(dev).toMatchObject({
      ...expected,
      identifier: "mobile-share-image-dev",
      local: true,
      remote: { urls: ["http://localhost:3000"] },
    })
    for (const capability of [mobileCapability, dev as Capability]) {
      expect(capability.permissions).not.toEqual(expect.arrayContaining([
        expect.stringMatching(/^(?:core:default$|core:event:|fs:|store:|deep-link:)/),
      ]))
    }
  })

  it("uses one shared exact-origin guard before either native image lease", () => {
    expect(imageRuntime).toContain("use crate::native_command_guard::guard;")
    expect(oauthRuntime).toContain("use crate::native_command_guard::guard;")
    expect(imageRuntime.indexOf("guard(&window)")).toBeLessThan(
      imageRuntime.indexOf("state.acquire()"),
    )
    expect(guard).toContain('label == "main"')
    expect(guard).toContain('"http://localhost:3000"')
    expect(guard).toContain('"https://alook.ai"')
    expect(guard).toContain("url.username().is_empty()")
    expect(guard).toContain("url.password().is_none()")
    expect(guard).toContain("https://alook.ai.evil.example/c")
  })

  it("generates command ACLs from AppManifest and registers the plugin only on mobile", () => {
    for (const command of ["mobile_share_image_copy", "mobile_share_image_save"]) {
      expect(build).toContain(`"${command}"`)
      expect(rustEntry).toContain(`mobile_share_image_runtime::${command}`)
    }
    expect(rustEntry).toContain("fn run_mobile(")
    expect(rustEntry).toContain("tauri_plugin_mobile_share_image::init()")
    expect(readTauri("Cargo.toml")).toContain(
      'tauri-plugin-mobile-share-image = { path = "plugins/mobile-share-image" }',
    )
    const handwritten = readdirSync(resolve(tauriRoot, "permissions"))
      .filter(name => name.endsWith(".toml"))
      .map(name => readTauri(`permissions/${name}`))
      .join("\n")
    expect(handwritten).not.toContain("allow-mobile-share-image-copy")
    expect(handwritten).not.toContain("allow-mobile-share-image-save")
  })

  it("keeps Android clipboard exposure narrow and storage permissions absent", () => {
    expect(appManifest).not.toContain("FileProvider")
    expect(pluginManifest).toContain(
      'android:name="ai.alook.plugin.mobileshareimage.MobileShareImageFileProvider"',
    )
    expect(pluginManifest).toContain(
      'android:authorities="${applicationId}.mobile_share_image.fileprovider"',
    )
    expect(pluginManifest).toContain('android:exported="false"')
    expect(pluginManifest).toContain('android:grantUriPermissions="true"')
    expect(providerPaths.match(/<cache-path/g)).toHaveLength(1)
    expect(providerPaths).toContain('path="mobile-share-image/clipboard/"')
    expect(providerPaths).not.toMatch(/<(?:external-path|external-files-path|root-path|files-path)\b/)
    expect(`${appManifest}\n${pluginManifest}`).not.toMatch(
      /READ_MEDIA_IMAGES|READ_EXTERNAL_STORAGE|WRITE_EXTERNAL_STORAGE/,
    )
  })

  it("locks the Android API split, exact journal, and dedicated SAF launcher", () => {
    expect(androidPlugin).toContain("Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q")
    expect(androidImage).toContain('private const val RELATIVE_PATH = "Pictures/Alook/"')
    expect(androidImage).toContain("MediaStore.Images.Media.IS_PENDING")
    expect(androidImage).toContain("MediaStore.Images.Media.OWNER_PACKAGE_NAME")
    expect(androidImage).toContain("MediaStore.QUERY_ARG_MATCH_PENDING")
    expect(androidDocumentOwner).toContain("Intent.ACTION_CREATE_DOCUMENT")
    expect(androidDocumentOwner).toContain("ActivityResultContracts.StartActivityForResult()")
    expect(androidDocumentOwner).toContain("activity.activityResultRegistry.register(")
    expect(androidDocumentOwner).toContain("deliver = { token, result ->")
    expect(androidDocumentResultAdapter).toContain(
      'private fun resultKey(token: String): String = "alook.mobileShareImage.document.$token"',
    )
    expect(androidDocumentResultAdapter).toContain("deliver(token, result)")
    expect(androidDocumentCore).toContain("class MobileShareImageDocumentCoordinatorCore")
    expect(androidDocumentCore).toContain("fun begin(")
    expect(androidDocumentCore).toContain("fun deliver(")
    expect(androidDocumentCore).toContain("MobileShareImageDocumentPhase.WRITING")
    const documentSources = [
      androidDocumentOwner,
      androidDocumentResultAdapter,
      androidDocumentCore,
    ].join("\n")
    expect(documentSources).not.toContain("startActivityForResult")
    expect(documentSources).not.toContain("@ActivityCallback")
    expect(documentSources).not.toContain("contentResolver.delete")
    expect(androidPlugin).toContain("commitMobileShareImageClipboard(")
    expect(androidClipboardTransaction.indexOf("publish()"))
      .toBeLessThan(androidClipboardTransaction.indexOf("runCatching(cleanupAfterPublish)"))
    expect(androidClipboardTransaction).not.toContain("deleteUnpublished()")
  })

  it("uses add-only PhotoKit and the iOS 14-compatible PNG resource property", () => {
    expect(iosProject).toContain(
      "NSPhotoLibraryAddUsageDescription: Allow Alook to save shared message images to Photos.",
    )
    expect(iosProject).not.toContain("NSPhotoLibraryUsageDescription")
    expect(iosPlugin).toContain("authorizationStatus(for: .addOnly)")
    expect(iosPlugin).toContain("requestAuthorization(for: .addOnly)")
    expect(iosPlugin).toContain("options.uniformTypeIdentifier = UTType.png.identifier")
    expect(iosPlugin).not.toContain("options.contentType")
    expect(iosPlugin).not.toContain("fetchAssets")
    expect(readPlugin("ios/Package.swift")).toContain("platforms: [.iOS(.v14)]")
  })

  it("preserves Web and desktop routes while mobile uses only its typed adapter", () => {
    const dialog = readRoot(
      "src/web/src/components/community/messages/message-share-dialog.tsx",
    )
    const adapter = readRoot("src/web/src/lib/community/mobile-share-image.ts")
    expect(dialog).toContain("const mobileNative = isTauri() && isMobile()")
    expect(dialog).toContain("if (isTauri() && isDesktop())")
    expect(dialog).toContain("navigator.clipboard.write")
    expect(dialog).toContain("anchor.download = filename")
    expect(dialog).toContain('await import("@/lib/community/mobile-share-image")')
    expect(dialog).not.toMatch(/^import .*mobile-share-image/m)
    expect(adapter).toContain('"mobile_share_image_copy"')
    expect(adapter).toContain('"mobile_share_image_save"')
    expect(adapter).not.toContain("setInterval")
    expect(adapter).not.toContain("heartbeat")
  })
})
