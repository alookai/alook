import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const root = resolve(import.meta.dirname, "../../src/desktop/src-tauri")
const read = (path: string) => readFileSync(resolve(root, path), "utf8")

const desktopCommands = [
  "daemon_runtime_capability",
  "daemon_pair",
  "set_window_theme",
  "close_splashscreen",
  "desktop_zoom_shortcut",
  "desktop_system_notification_show",
  "desktop_system_notification_listen",
  "desktop_system_notification_take_activation",
  "desktop_system_notification_unlisten",
]

function quotedValues(source: string) {
  return Array.from(source.matchAll(/"([a-z][a-z0-9_]*)"/g), (match) => match[1]!)
}

describe("desktop system notification contract", () => {
  it("keeps the build manifest and desktop ACL at the exact old-five plus new-four set", () => {
    const manifestCommands = quotedValues(read("build.rs"))
      .filter((command) => !command.startsWith("native_oauth_") && !command.startsWith("mobile_share_image_"))
    const permissionCommands = quotedValues(
      read("permissions/desktop-commands.toml").match(/commands\.allow\s*=\s*\[[^\]]*\]/s)?.[0] ?? "",
    )
    expect(manifestCommands).toEqual(desktopCommands)
    expect(permissionCommands).toEqual(desktopCommands)
  })

  it("preserves the existing narrow production capability and desktop scheme", () => {
    const capability = JSON.parse(read("capabilities/desktop.json")) as {
      identifier: string
      local: boolean
      windows: string[]
      platforms: string[]
      remote: { urls: string[] }
      permissions: string[]
    }
    const config = JSON.parse(read("tauri.conf.json")) as {
      plugins: { "deep-link": { desktop: { schemes: string[] } } }
    }
    expect(capability).toMatchObject({
      identifier: "desktop-capability",
      local: true,
      windows: ["main"],
      remote: { urls: ["https://alook.ai"] },
      permissions: ["clipboard-manager:allow-write-image", "desktop-commands"],
    })
    expect(capability.platforms).toEqual(expect.arrayContaining(["linux", "macOS", "windows"]))
    expect(config.plugins["deep-link"].desktop.schemes).toEqual(["ai.alook.desktop"])
  })

  it("keeps platform behavior split between exact activation and Linux focus-only", () => {
    const source = read("src/system_notifications.rs")
    expect(source).toContain('#[cfg(target_os = "macos")]')
    expect(source).toContain('#[cfg(windows)]')
    expect(source).toContain('#[cfg(target_os = "linux")]')
    expect(source).toContain('<toast activationType=\\"protocol\\"')
    expect(source).toContain("didReceiveNotificationResponse")
    const linux = source.slice(source.lastIndexOf('#[cfg(target_os = "linux")]'))
    expect(linux).toContain("show_main_window")
    expect(linux).not.toContain("activate(&app")
  })

  it("does not gate delivery on main-window visibility and preserves real Quit", () => {
    const runtime = read("src/system_notifications.rs")
    const commands = read("src/commands.rs")
    const app = read("src/lib.rs")
    expect(runtime).not.toContain("is_visible")
    expect(app).toContain("api.prevent_close();")
    expect(app).toContain("let _ = window.hide();")
    expect(commands).toContain("app.exit(0);")
  })
})
