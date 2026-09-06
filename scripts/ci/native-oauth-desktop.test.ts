import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
const root = resolve(import.meta.dirname, "../../src/desktop/src-tauri")
const read = (file: string) => readFileSync(resolve(root, file), "utf8")
type Capability = { identifier: string; local?: boolean; remote?: { urls: string[] }; windows: string[]; platforms?: string[]; permissions: (string | { identifier: string })[] }
type Config = { app: { security: { capabilities: (string | Capability)[] } }; plugins?: { "deep-link"?: unknown } }
const production: Config = JSON.parse(read("tauri.conf.json"))
const development: Config = JSON.parse(read("tauri.dev.conf.json"))
const capabilities = (config: Config): Capability[] => config.app.security.capabilities.map(c => typeof c === "string" ? JSON.parse(read(`capabilities/${c === "desktop-capability" ? "desktop" : c}.json`)) : c)

describe("desktop native OAuth security configuration", () => {
  it.each([production, development])("merged permissions cannot listen to raw events or read native storage/deep-link state", config => {
    const merged = capabilities(config)
    for (const permission of merged.flatMap(c => c.permissions).map(p => typeof p === "string" ? p : p.identifier)) {
      expect(permission).not.toMatch(/^(?:core:default$|core:event:|deep-link:|store:)/)
    }
    const oauth = merged.find(c => c.permissions.includes("native-oauth"))!
    expect(oauth.windows).toEqual(["main"])
    expect(oauth.platforms).toEqual(expect.arrayContaining(["linux", "macOS", "windows"]))
    expect(oauth.remote?.urls).toEqual(config === production ? ["https://alook.ai"] : ["http://localhost:3000"])
    expect(oauth.local).toBe(config === development)
  })
  it("requires explicit command ACL while preserving preexisting desktop custom commands", () => {
    const build = read("build.rs")
    const native = read("permissions/native-oauth.toml")
    const existing = read("permissions/desktop-commands.toml")
    for (const command of ["snapshot", "listen", "unlisten", "prepare", "open_start", "pending_exchange", "reject_candidate", "finish", "cancel"]) {
      expect(build).toContain(`"native_oauth_${command}"`)
      expect(native).toContain(`"native_oauth_${command}"`)
    }
    for (const command of ["daemon_runtime_capability", "daemon_pair", "set_window_theme", "close_splashscreen", "desktop_zoom_shortcut"]) {
      expect(build).toContain(`"${command}"`)
      expect(existing).toContain(`"${command}"`)
    }
    expect(capabilities(production).find(c => c.identifier === "desktop-capability")?.permissions).toContain("desktop-commands")
  })
  it("preserves the desktop-only scheme and ordered single-instance intake", () => {
    expect(production.plugins?.["deep-link"]).toMatchObject({ desktop: { schemes: ["ai.alook.desktop"] } })
    const source = read("src/lib.rs")
    expect(source.indexOf("tauri_plugin_single_instance::init")).toBeLessThan(source.indexOf("tauri_plugin_deep_link::init"))
    expect(source.indexOf("tauri_plugin_deep_link::init")).toBeLessThan(source.indexOf("tauri_plugin_opener::init"))
    expect(read("Cargo.toml")).toContain('tauri-plugin-single-instance = { version = "2", features = ["deep-link"] }')
    const runtime = read("src/native_oauth_runtime.rs")
    expect(runtime.indexOf(".on_open_url(")).toBeLessThan(runtime.indexOf(".get_current()"))
    expect(runtime).toContain('#[cfg(target_os = "linux")]')
    expect(runtime).toContain(".register_all()")
    expect(runtime).toContain("channel.send(())")
    expect(source).toContain("PageLoadEvent::Started")
    expect(source).toContain("WindowEvent::Destroyed")
  })
})
