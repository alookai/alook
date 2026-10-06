import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { describe, expect, it } from "vitest"
import { prepareIosDevelopmentPlist } from "../../src/desktop/scripts/ios-dev.mjs"

const root = resolve(import.meta.dirname, "../..")
const tauriRoot = resolve(root, "src/desktop/src-tauri")
const read = (path: string) => readFileSync(resolve(tauriRoot, path), "utf8")
const base = JSON.parse(read("tauri.conf.json"))
const release = JSON.parse(read("tauri.ios.release.conf.json"))
const development = JSON.parse(read("tauri.dev.conf.json"))

describe("Tauri startup release separation", () => {
  it("retains the complete main window and bounds only the release overlay", () => {
    expect(release.app.windows).toEqual(base.app.windows.map((window: object) => ({
      ...window,
      limitNavigationsToAppBoundDomains: true,
    })))
    expect(release.bundle.iOS.infoPlist).toBe("Info.ios.release.plist")
    expect(base.app.windows.every((window: Record<string, unknown>) => !window.limitNavigationsToAppBoundDomains)).toBe(true)
    expect(development.app.windows).toBeUndefined()
    expect(development.bundle?.iOS?.infoPlist).toBeUndefined()
    expect(existsSync(resolve(tauriRoot, "Info.ios.plist"))).toBe(false)
    const plist = read("Info.ios.release.plist")
    expect([...plist.matchAll(/<string>([^<]+)<\/string>/g)].map(match => match[1])).toEqual(["localhost", "alook.ai"])
  })

  it("loads the release overlay and checks the actual IPA without dropping build version", () => {
    const workflow = readFileSync(resolve(root, ".github/workflows/mobile-release.yml"), "utf8")
    expect(workflow).toContain("--config src-tauri/tauri.ios.release.conf.json")
    expect(workflow).toContain('assert info["WKAppBoundDomains"] == ["localhost", "alook.ai"]')
    expect(workflow).toContain('bundleVersion\\\":\\\"${GITHUB_RUN_NUMBER}')
    const pkg = JSON.parse(readFileSync(resolve(root, "src/desktop/package.json"), "utf8"))
    expect(pkg.scripts.ios).toBe("node scripts/ios-dev.mjs --config src-tauri/tauri.dev.conf.json")
  })

  it("pins the host and every local native plugin to the same Tauri release", () => {
    for (const path of ["Cargo.toml", ...["file-save", "mobile-share-image", "mobile-push"].map(plugin => `plugins/${plugin}/Cargo.toml`)]) {
      expect(read(path)).toContain('version = "=2.12.1"')
      expect(read(path)).not.toContain('version = "=2.11.2"')
    }
  })

  it("does not require a generated plist on a fresh development checkout", () => {
    expect(prepareIosDevelopmentPlist(resolve(tauriRoot, "nonexistent-test.plist"))).toBe(false)
  })

  it.runIf(process.platform === "darwin")("removes a stale release key and preserves unrelated generated plist values", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "alook-startup-plist-"))
    const path = resolve(directory, "Info.plist")
    try {
      writeFileSync(path, read("Info.ios.release.plist").replace("</dict>", '<key>CFBundleIdentifier</key><string>ai.alook.ios</string><key>LSRequiresIPhoneOS</key><true/><key>NSPhotoLibraryAddUsageDescription</key><string>Allow save</string></dict>'))
      expect(prepareIosDevelopmentPlist(path)).toBe(true)
      expect(prepareIosDevelopmentPlist(path)).toBe(false)
      expect(spawnSync("/usr/libexec/PlistBuddy", ["-c", "Print :WKAppBoundDomains", path]).status).not.toBe(0)
      expect(spawnSync("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleIdentifier", path], { encoding: "utf8" }).stdout.trim()).toBe("ai.alook.ios")
      expect(spawnSync("/usr/libexec/PlistBuddy", ["-c", "Print :LSRequiresIPhoneOS", path], { encoding: "utf8" }).stdout.trim()).toBe("true")
      expect(spawnSync("/usr/libexec/PlistBuddy", ["-c", "Print :NSPhotoLibraryAddUsageDescription", path], { encoding: "utf8" }).stdout.trim()).toBe("Allow save")
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it.runIf(process.platform === "darwin")("fails closed on a malformed generated plist", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "alook-startup-plist-invalid-"))
    try {
      const path = resolve(directory, "Info.plist")
      writeFileSync(path, "not a plist")
      expect(() => prepareIosDevelopmentPlist(path)).toThrow()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
