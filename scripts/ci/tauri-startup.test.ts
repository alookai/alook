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

function verifyIosArtifact(orientationKey?: string, orientations?: string[]) {
  const workflow = readFileSync(resolve(root, ".github/workflows/mobile-release.yml"), "utf8")
  const validator = workflow.match(/^\s+python3 - "\$app_path\/Info\.plist" "\$entitlements_path" <<'PY'\n([\s\S]*?)^\s+PY$/m)
  expect(validator).not.toBeNull()
  const info: Record<string, unknown> = {
    CFBundleIdentifier: "ai.alook.ios",
    WKAppBoundDomains: ["localhost", "alook.ai"],
    UISupportedInterfaceOrientations: ["UIInterfaceOrientationPortrait"],
    "UISupportedInterfaceOrientations~ipad": ["UIInterfaceOrientationPortrait"],
    CFBundleURLTypes: [{ CFBundleURLName: "ai.alook", CFBundleURLSchemes: ["ai.alook"] }],
  }
  if (orientationKey) {
    if (orientations) info[orientationKey] = orientations
    else delete info[orientationKey]
  }
  return spawnSync("python3", ["-c", `
import json
import pathlib
import plistlib
import sys
import tempfile
import textwrap

validator = textwrap.dedent(sys.argv[1])
fixture = json.load(sys.stdin)
with tempfile.TemporaryDirectory(prefix="alook-ipa-metadata-") as directory:
    paths = [pathlib.Path(directory) / (name + ".plist") for name in ["info", "entitlements"]]
    for name, path in zip(["info", "entitlements"], paths):
        path.write_bytes(plistlib.dumps(fixture[name]))
    sys.argv = ["ipa-metadata"] + [str(path) for path in paths]
    exec(compile(validator, "mobile-release-ipa-metadata", "exec"))
`, validator![1]], {
    encoding: "utf8",
    input: JSON.stringify({
      info,
      entitlements: {
        "application-identifier": "5RF24VHDQB.ai.alook.ios",
        "com.apple.developer.team-identifier": "5RF24VHDQB",
        "com.apple.developer.associated-domains": ["applinks:auth.alook.ai"],
        "aps-environment": "production",
      },
    }),
  })
}

describe("Tauri startup release separation", () => {
  it("retains the complete main window and bounds only the release overlay", () => {
    expect(release.app.windows).toEqual(base.app.windows.map((window: object) => ({
      ...window,
      limitNavigationsToAppBoundDomains: true,
    })))
    expect(release.bundle.iOS.infoPlist).toBe("Info.ios.release.plist")
    expect(base.app.windows.every((window: Record<string, unknown>) => !window.limitNavigationsToAppBoundDomains)).toBe(true)
    expect(development.app.windows).toEqual(base.app.windows.map((window: object) => ({
      ...window,
      url: "alook-recovery://localhost/bootstrap",
    })))
    expect(development.build).toEqual({ frontendDist: "http://localhost:3000", devUrl: "http://localhost:3000" })
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
    const declarations = (text: string) => [...text.matchAll(/^tauri\s*=\s*\{[^\n]*version\s*=\s*"(=[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)"/gm)].map(match => match[1])
    const selected = declarations(read("Cargo.toml"))
    expect(selected).toHaveLength(1)
    for (const plugin of ["file-save", "mobile-share-image", "mobile-push"]) {
      const versions = declarations(read(`plugins/${plugin}/Cargo.toml`))
      expect(versions.length, plugin).toBeGreaterThan(0)
      for (const version of versions) expect(version, plugin).toBe(selected[0])
    }
  })

  it("accepts the final IPA metadata with portrait-only phone and tablet declarations", () => {
    const result = verifyIosArtifact()
    expect(result.error).toBeUndefined()
    expect(result.status, result.stderr).toBe(0)
  })

  const invalidOrientations: [string, string, string[] | undefined][] = [
    ["phone landscape", "UISupportedInterfaceOrientations", ["UIInterfaceOrientationPortrait", "UIInterfaceOrientationLandscapeLeft"]],
    ["tablet landscape", "UISupportedInterfaceOrientations~ipad", ["UIInterfaceOrientationPortrait", "UIInterfaceOrientationLandscapeRight"]],
    ["tablet upside-down", "UISupportedInterfaceOrientations~ipad", ["UIInterfaceOrientationPortrait", "UIInterfaceOrientationPortraitUpsideDown"]],
    ["missing phone", "UISupportedInterfaceOrientations", undefined],
    ["missing tablet", "UISupportedInterfaceOrientations~ipad", undefined],
  ]
  it.each(invalidOrientations)("rejects final IPA metadata with %s declarations", (_name, key, orientations) => {
    const result = verifyIosArtifact(key, orientations)
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/AssertionError|KeyError/)
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
