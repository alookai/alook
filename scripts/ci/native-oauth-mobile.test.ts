import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import {
  ANDROID_ASSET_LINKS,
  APPLE_APP_SITE_ASSOCIATION,
  AUTH_WORKER_HOST,
  AUTH_WORKER_RETURN_PATH,
} from "../../src/web/auth/index"

const root = resolve(import.meta.dirname, "../..")
const tauriRoot = resolve(root, "src/desktop/src-tauri")
const readRoot = (file: string) => readFileSync(resolve(root, file), "utf8")
const readTauri = (file: string) => readFileSync(resolve(tauriRoot, file), "utf8")

type Capability = {
  identifier: string
  local: boolean
  remote: { urls: string[] }
  windows: string[]
  platforms: string[]
  permissions: string[]
}

type MobileLink = {
  scheme: string[]
  host: string
  path: string[]
  appLink?: boolean
}

const production = JSON.parse(readTauri("tauri.conf.json")) as {
  app: { security: { capabilities: string[] } }
  plugins: { "deep-link": { mobile: MobileLink[]; desktop: { schemes: string[] } } }
}
const development = JSON.parse(readTauri("tauri.dev.conf.json")) as {
  app: { security: { capabilities: Array<string | Capability> } }
}
const ios = JSON.parse(readTauri("tauri.ios.conf.json")) as {
  identifier: string
  bundle: { iOS: { developmentTeam: string } }
}
const android = JSON.parse(readTauri("tauri.android.conf.json")) as { identifier: string }
const mobileCapability = JSON.parse(
  readTauri("capabilities/native-oauth-mobile.json"),
) as Capability
const androidManifest = readTauri("gen/android/app/src/main/AndroidManifest.xml")
const iosEntitlements = readTauri(
  "gen/apple/alook-desktop_iOS/alook-desktop_iOS.entitlements",
)
const iosProject = readTauri("gen/apple/project.yml")
const cargo = readTauri("Cargo.toml")
const rustEntry = readTauri("src/lib.rs")
const mobileRelease = readRoot(".github/workflows/mobile-release.yml")
const desktopPackage = JSON.parse(readRoot("src/desktop/package.json")) as {
  scripts: Record<string, string>
}

const intentFilters = Array.from(
  androidManifest.matchAll(/<intent-filter([^>]*)>([\s\S]*?)<\/intent-filter>/g),
  match => ({ attributes: match[1], body: match[2] }),
)

describe("native OAuth mobile activation", () => {
  it("declares one exact verified HTTPS link and one exact non-verified fallback", () => {
    expect(production.plugins["deep-link"].mobile).toEqual([
      {
        scheme: ["https"],
        host: "auth.alook.ai",
        path: ["/auth/native/return"],
      },
      {
        scheme: ["ai.alook"],
        host: "auth",
        path: ["/native/return"],
        appLink: false,
      },
    ])
    expect(production.plugins["deep-link"].desktop).toEqual({
      schemes: ["ai.alook.desktop"],
    })
  })

  it("grants only the existing command ACL to trusted mobile WebViews", () => {
    expect(production.app.security.capabilities).toContain("native-oauth-mobile")
    expect(mobileCapability).toMatchObject({
      identifier: "native-oauth-mobile",
      windows: ["main"],
      platforms: ["android", "iOS"],
      local: false,
      remote: { urls: ["https://alook.ai"] },
      permissions: ["native-oauth"],
    })
    expect(mobileCapability.permissions).not.toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^(?:core:default$|core:event:|deep-link:|store:)/),
      ]),
    )
    const devOauth = development.app.security.capabilities.find(
      capability => typeof capability !== "string" && capability.identifier === "native-oauth-dev",
    )
    expect(devOauth).toMatchObject({
      windows: ["main"],
      platforms: ["linux", "macOS", "windows", "android", "iOS"],
      remote: { urls: ["http://localhost:3000"] },
      permissions: ["native-oauth"],
    })
    expect(desktopPackage.scripts.ios).toContain(
      "--config src-tauri/tauri.dev.conf.json",
    )
    expect(desktopPackage.scripts.android).toContain(
      "--config src-tauri/tauri.dev.conf.json",
    )
  })

  it("builds the native owner on mobile without moving single-instance off desktop", () => {
    const desktopTarget = cargo.indexOf('[target."cfg(not(any(target_os')
    expect(desktopTarget).toBeGreaterThan(0)
    const common = cargo.slice(0, desktopTarget)
    const desktopOnly = cargo.slice(desktopTarget)
    for (const dependency of [
      "tauri-plugin-deep-link",
      "tauri-plugin-store",
      "base64",
      "getrandom",
      "sha2",
      "subtle",
      "url",
    ]) {
      expect(common).toContain(`${dependency} =`)
      expect(desktopOnly).not.toContain(`${dependency} =`)
    }
    expect(desktopOnly).toContain("tauri-plugin-single-instance")
    expect(rustEntry).toContain("fn run_mobile(")
    expect(rustEntry).toContain("native_oauth_runtime::native_oauth_prepare")
    expect(rustEntry).toContain("native_oauth_runtime::setup(app.handle())")
    expect(rustEntry.indexOf("tauri_plugin_single_instance::init")).toBeLessThan(
      rustEntry.indexOf("tauri_plugin_deep_link::init"),
    )
    expect(rustEntry.indexOf("tauri_plugin_deep_link::init")).toBeLessThan(
      rustEntry.indexOf("tauri_plugin_opener::init"),
    )
  })

  it("maps one real mobile resume event to one OAuth re-drive", () => {
    expect(rustEntry).toMatch(
      /tauri::RunEvent::WindowEvent\s*\{\s*label,\s*event,\s*\.\./,
    )
    expect(rustEntry).toMatch(
      /#\[cfg\(mobile\)\]\s*\{\s*matches!\(event, tauri::WindowEvent::Resumed\)/,
    )
    expect(rustEntry).not.toContain("tauri::RunEvent::Resumed")
    expect(
      rustEntry.match(/native_oauth_runtime::notify_listener\(app\)/g),
    ).toHaveLength(1)
  })

  it("keeps generated Apple identity, entitlement, and fallback sources aligned", () => {
    expect(ios).toEqual({
      $schema: "./gen/schemas/ios-schema.json",
      identifier: "ai.alook.ios",
      bundle: { iOS: { developmentTeam: "5RF24VHDQB" } },
    })
    expect(iosProject).toContain("PRODUCT_BUNDLE_IDENTIFIER: ai.alook.ios")
    expect(iosProject).toContain("DEVELOPMENT_TEAM: 5RF24VHDQB")
    expect(iosProject).toContain("CFBundleURLTypes:")
    expect(iosProject).toContain("CFBundleURLSchemes: [ai.alook]")
    expect(iosProject).toContain("com.apple.developer.associated-domains:")
    expect(iosProject).toContain("applinks:auth.alook.ai")
    expect(iosEntitlements).toContain("<string>applinks:auth.alook.ai</string>")
    expect(mobileRelease).toContain('info["CFBundleURLTypes"] ==')
    expect(mobileRelease).toContain("ai.alook")
  })

  it("keeps generated Android verified and fallback intents separate on singleTask", () => {
    expect(android.identifier).toBe("ai.alook.android")
    expect(androidManifest).toContain('android:launchMode="singleTask"')
    const verified = intentFilters.find(filter => filter.attributes.includes("autoVerify"))
    expect(verified?.body).toContain('<data android:scheme="https" />')
    expect(verified?.body).toContain('<data android:host="auth.alook.ai" />')
    expect(verified?.body).toContain('<data android:path="/auth/native/return" />')
    const fallback = intentFilters.find(filter => filter.body.includes('android:scheme="ai.alook"'))
    expect(fallback?.attributes).not.toContain("autoVerify")
    expect(fallback?.body).toContain('<data android:host="auth" />')
    expect(fallback?.body).toContain('<data android:path="/native/return" />')
  })

  it("ties native identities and the release signer to hosted association JSON", () => {
    expect(AUTH_WORKER_HOST).toBe("auth.alook.ai")
    expect(AUTH_WORKER_RETURN_PATH).toBe("/auth/native/return")
    expect(APPLE_APP_SITE_ASSOCIATION.applinks.details).toEqual([
      expect.objectContaining({
        appID: `${ios.bundle.iOS.developmentTeam}.${ios.identifier}`,
        components: [expect.objectContaining({ "/": AUTH_WORKER_RETURN_PATH })],
      }),
    ])
    expect(ANDROID_ASSET_LINKS).toEqual([
      expect.objectContaining({
        target: expect.objectContaining({
          package_name: android.identifier,
          sha256_cert_fingerprints: [
            "9D:C6:ED:E9:4B:A6:63:EE:C9:EC:98:FF:7B:AF:D5:5E:24:8B:6C:4B:C2:15:7F:CF:04:2D:F5:9B:0E:41:08:06",
          ],
        }),
      }),
    ])
    expect(mobileRelease).toContain(
      "9DC6EDE94BA663EEC9EC98FF7BAFD55E248B6C4BC2157FCF042DF59B0E410806",
    )
    for (const value of [
      JSON.stringify(production),
      iosEntitlements,
      androidManifest,
      readRoot("src/web/auth/index.ts"),
    ]) {
      expect(value).not.toContain("link.alook.ai")
    }
  })
})
