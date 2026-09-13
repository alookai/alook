import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
const root = resolve(import.meta.dirname, "../../src/desktop/src-tauri")
const read = (path: string) => readFileSync(resolve(root, path), "utf8")
const commands = ["file_save_begin", "file_save_write_chunk", "file_save_commit", "file_save_cancel"]
describe("native file save boundary", () => {
  it("grants only the four guarded commands to the exact main production origin", () => {
    const capability = JSON.parse(read("capabilities/file-save.json"))
    expect(capability).toMatchObject({ identifier: "file-save", windows: ["main"], local: false, remote: { urls: ["https://alook.ai"] }, permissions: commands.map(c => `allow-${c.replaceAll("_", "-")}`) })
    expect(Object.keys(capability).sort()).toEqual(["description", "identifier", "local", "permissions", "remote", "windows"])
    expect(JSON.parse(read("tauri.conf.json")).app.security.capabilities).toContain("file-save")
    for (const command of commands) {
      expect(read("build.rs")).toContain(`"${command}"`)
      expect(read("src/lib.rs").match(new RegExp(`file_save_runtime::${command}`, "g"))).toHaveLength(2)
    }
    expect(read("src/file_save_runtime.rs").match(/native_command_guard::guard\(&window\)/g)).toHaveLength(4)
  })
  it("allows Tauri devUrl local classification only in the main development capability", () => {
    const capabilities = JSON.parse(read("tauri.dev.conf.json")).app.security.capabilities
    const capability = capabilities.find((entry: { identifier?: string } | string) => typeof entry !== "string" && entry.identifier === "file-save-dev")
    expect(capability).toEqual({
      identifier: "file-save-dev", description: "User file save from the trusted main webview",
      windows: ["main"], local: true, remote: { urls: ["http://localhost:3000"] },
      permissions: commands.map(c => `allow-${c.replaceAll("_", "-")}`),
    })
    expect(JSON.parse(read("capabilities/file-save.json")).local).toBe(false)
    expect(JSON.parse(read("tauri.conf.json")).app.security.capabilities).not.toContain("file-save-dev")
  })
  it("does not grant the private mobile exporter or let the web choose paths", () => {
    expect(read("plugins/file-save/build.rs")).toContain("Builder::new(&[])")
    const core = read("src/file_save.rs")
    const begin = core.slice(core.indexOf("pub struct Begin"), core.indexOf("pub struct Chunk"))
    expect(begin).not.toMatch(/pub (path|destination|url|token):/)
    expect(read("plugins/file-save/android/src/main/java/ai/alook/plugin/filesave/FileSavePlugin.kt")).toContain('source.name == args.attemptId + ".partial"')
    expect(read("plugins/file-save/ios/Sources/FileSavePlugin.swift")).toContain('source.lastPathComponent == args.attemptId + ".partial"')
  })
  it("hooks Android picker ownership into activity recreation", () => {
    const activity = read("gen/android/app/src/main/java/ai/alook/android/MainActivity.kt")
    for (const call of ["attach(savedInstanceState)", "saveState(outState)", "detach()"]) expect(activity).toContain(`fileSaveDocumentOwner.${call}`)
  })
})
