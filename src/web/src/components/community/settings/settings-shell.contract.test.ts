import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const settingsDirectory = dirname(fileURLToPath(import.meta.url))
const readSettings = (file: string) => readFileSync(resolve(settingsDirectory, file), "utf8")

describe("shared settings shell", () => {
  it("owns the responsive tabs, header, content frame, and test IDs", () => {
    const source = readSettings("settings-shell.tsx")

    expect(source).toContain("useBreakpoint()")
    expect(source).toContain('breakpoint === "mobile" ? "horizontal" : "vertical"')
    expect(source).toContain("grid-rows-[3rem_auto_minmax(0,1fr)]")
    expect(source).toContain("sm:grid-cols-[11rem_minmax(0,1fr)]")
    expect(source).toContain("data-testid={tid.settingsNav}")
    expect(source).toContain("data-testid={tid.settingsContent}")
    expect(source).toContain("data-testid={tid.settingsClose}")
    expect(source).toContain("data-testid={tid.settingsLabel}")
    expect(source).toContain('className="size-11 sm:size-8"')
    expect(source).toContain("<TabsContent {...props} keepMounted />")
  })

  it("is the only settings layout used by both user and server settings", () => {
    for (const file of ["user-settings.tsx", "server-settings.tsx"]) {
      const source = readSettings(file)
      expect(source).toContain("<SettingsShell")
      expect(source).toContain("<SettingsShellPanel")
      expect(source).not.toContain("<Tabs ")
      expect(source).not.toContain("SETTINGS_NAV_CLASS")
      expect(source).not.toContain("SETTINGS_TABS_LIST_CLASS")
    }
  })
})
