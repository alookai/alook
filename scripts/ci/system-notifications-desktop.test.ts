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
  "desktop_system_notification_retry_activation",
  "desktop_system_notification_dismiss",
  "desktop_system_notification_dismiss_conversation",
  "desktop_system_notification_unlisten",
]

function startupSnapshot(source: string) {
  const snapshot = source.match(/#\[cfg\(all\(target_os = "macos", debug_assertions\)\)\]\npub\(crate\) fn diagnose_qa_main_snapshot\(window: &WebviewWindow\) \{[\s\S]*?\n\}/g) ?? []
  expect(snapshot).toHaveLength(1)
  return snapshot[0]!
}

function quotedValues(source: string) {
  return Array.from(source.matchAll(/"([a-z][a-z0-9_]*)"/g), (match) => match[1]!)
}

describe("desktop system notification contract", () => {
  it("keeps the build manifest and desktop ACL at the exact old-five plus notification command set", () => {
    const manifestCommands = quotedValues(read("build.rs"))
      .filter((command) => !command.startsWith("native_oauth_")
        && !command.startsWith("mobile_share_image_")
        && !command.startsWith("mobile_system_notification_")
        && !command.startsWith("file_save_"))
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
    expect(source).toContain("removeDeliveredNotificationsWithIdentifiers")
    expect(source).toContain("RemoveGroupedTagWithId")
    expect(source).toContain("SetTag(&HSTRING::from(notification_id))")
    const linux = source.slice(source.lastIndexOf('#[cfg(target_os = "linux")]'))
    expect(linux).toContain("show_main_window")
    expect(linux).not.toContain("activate(&app")
  })

  it("limits startup snapshot reads to the exact QA handoff after its result and outer dispatch return", () => {
    const runtime = read("src/system_notifications.rs")
    const recovery = read("src/webview_recovery.rs")
    const commands = read("src/commands.rs")
    const snapshot = startupSnapshot(runtime)
    const qualification = runtime.slice(
      runtime.indexOf("pub(crate) fn notification_diagnostics_enabled"),
      runtime.indexOf("macro_rules! notification_diagnostic"),
    )
    expect(qualification).toContain('cfg!(all(target_os = "macos", debug_assertions))')
    expect(qualification).toContain('identifier == "ai.alook.desktop.qa.madox.notification208" && switch == Some("208")')
    const rejection = snapshot.indexOf("if !notification_diagnostics_enabled(window.app_handle()) {\n        return;\n    }")
    expect(rejection).toBeGreaterThan(-1)
    expect(snapshot.match(/\.is_visible\(\)/g)).toHaveLength(1)
    expect(snapshot.match(/\.url\(\)/g)).toHaveLength(1)
    expect(rejection).toBeLessThan(snapshot.indexOf(".is_visible()"))
    expect(snapshot.indexOf(".is_visible()")).toBeLessThan(snapshot.indexOf(".url()"))
    const handoff = recovery.slice(recovery.indexOf("pub fn finish_native_creation"), recovery.indexOf("fn apple_class_method"))
    const callbackStart = handoff.indexOf("let dispatched = window.with_webview(move |platform| {")
    const callbackEnd = handoff.indexOf("\n    });", callbackStart)
    expect(callbackStart).toBeGreaterThan(-1)
    expect(callbackEnd).toBeGreaterThan(callbackStart)
    const callback = handoff.slice(callbackStart, callbackEnd)
    const afterDispatch = handoff.slice(callbackEnd)
    expect(handoff.indexOf('"handoff_return"')).toBeGreaterThan(handoff.indexOf("let completed ="))
    expect(callback).not.toContain("diagnose_qa_main_snapshot")
    expect(callback).not.toMatch(/\.(?:url|is_visible)\(/)
    expect(callback).toContain("sender.send((completed, shown_main))")
    expect(callback.indexOf("sender.send((completed, shown_main))")).toBeGreaterThan(callback.indexOf('"handoff_return"'))
    expect(afterDispatch.indexOf("receiver.try_recv()")).toBeGreaterThan(afterDispatch.indexOf('"handoff_dispatch_return"'))
    expect(afterDispatch.indexOf("diagnose_qa_main_snapshot(&main)")).toBeGreaterThan(afterDispatch.indexOf("receiver.try_recv()"))
    expect(afterDispatch).toContain("qa_startup_snapshot_candidate(dispatched.is_ok(), receiver.try_recv())")
    expect(afterDispatch).toContain("Ok((true, Some(main))) => Ok(main)")
    expect(afterDispatch).toContain('return Err("dispatch_error")')
    expect(afterDispatch).toContain('Err("handoff_not_eligible")')
    const frontend = commands.slice(commands.indexOf("pub fn close_splashscreen"), commands.indexOf("// --- Daemon commands ---"))
    expect(frontend).toContain("try_close_splashscreen(&handle, None)")
    expect(frontend).not.toContain("diagnose_qa_main_snapshot")
  })

  it("keeps the one-shot handoff channel and actual thread record inside QA diagnostics", () => {
    const recovery = read("src/webview_recovery.rs")
    const handoff = recovery.slice(recovery.indexOf("pub fn finish_native_creation"), recovery.indexOf("fn apple_class_method"))
    expect(handoff).toContain('#[cfg(all(target_os = "macos", debug_assertions))]\n    let (diagnostic_sender, diagnostic_receiver) =')
    expect(handoff).toContain("if crate::system_notifications::notification_diagnostics_enabled(window.app_handle()) {")
    expect(handoff.match(/std::sync::mpsc::channel\(\)/g)).toHaveLength(1)
    expect(handoff.match(/receiver\.try_recv\(\)/g)).toHaveLength(1)
    expect(handoff).not.toMatch(/\.(?:recv|recv_timeout|recv_deadline)\(/)
    expect(handoff).not.toMatch(/\b(?:loop|while|sleep|spawn|run_on_main_thread)\b(?!\(show_native_creation_error\))/)
    expect(handoff).toContain('"dispatchMode": if *calling_thread == callback_thread { "inline" } else { "queued" }')
    expect(handoff).toContain('"callingThread": format!("{calling_thread:?}")')
    expect(handoff).toContain('"callbackThread": format!("{callback_thread:?}")')
    expect(handoff).toContain('"handoff_result_send_return"')
    expect(handoff).toContain('"main_snapshot_not_run"')
    expect(handoff).toContain('"callbackCompletion": "not_inferred"')
    expect(handoff).toContain('Err("handoff_result_pending")')
    expect(handoff).toContain('Err("handoff_result_unavailable")')
  })

  it("does not gate delivery on main-window visibility and preserves real Quit", () => {
    const runtime = read("src/system_notifications.rs")
    const commands = read("src/commands.rs")
    const app = read("src/lib.rs")
    const snapshot = startupSnapshot(runtime)
    expect(runtime.replace(snapshot, "")).not.toContain("is_visible")
    expect(app).toContain("api.prevent_close();")
    expect(app).toContain("let _ = window.hide();")
    expect(commands).toContain("app.exit(0);")
  })
})
