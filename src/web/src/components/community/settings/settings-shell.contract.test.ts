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
    expect(source).toContain("styles.shell")
    expect(source).toContain("data-testid={tid.settingsNav}")
    expect(source).toContain("data-testid={tid.settingsContent}")
    expect(source).toContain("data-testid={tid.settingsClose}")
    expect(source).toContain("data-testid={tid.settingsLabel}")
    expect(source).toContain('className="size-11 sm:size-8"')
    expect(source).toContain("sm:p-8 sm:pt-4")
    expect(source).not.toContain("items-center border-b border-border")
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

  it("keeps Privacy last, the nav footer limited to Log Out, and profile actions aligned", () => {
    const source = readSettings("user-settings.tsx")
    const privacyTab = source.indexOf('{ value: "privacy", label: "Privacy"')
    const advancedTab = source.indexOf('{ value: "advanced", label: "Advanced"')
    const navFooterStart = source.indexOf("navFooter={")
    const navFooter = source.slice(navFooterStart, source.indexOf("\n    >", navFooterStart))
    const profileStart = source.indexOf('<SettingsShellPanel value="profile">')
    const profile = source.slice(profileStart, source.indexOf('<SettingsShellPanel value="appearance">'))
    const accountDeletion = profile.indexOf('aria-label="Delete account"')
    const cancel = profile.indexOf(">Cancel</Button>")
    const save = profile.indexOf(">Save changes</Button>")

    expect(privacyTab).toBeGreaterThan(advancedTab)
    expect(navFooter).toContain('aria-label="Log out"')
    expect(navFooter).not.toContain('aria-label="Delete account"')
    expect(accountDeletion).toBeGreaterThan(-1)
    expect(cancel).toBeGreaterThan(accountDeletion)
    expect(save).toBeGreaterThan(cancel)
    expect(source).toContain("<PrivacyPolicyContent />")
    expect(source).not.toContain("Trash2")
    expect(profile).toContain('className="flex flex-wrap items-center gap-x-4 gap-y-2"')
    expect(profile).toContain('className="ml-auto flex shrink-0 items-center gap-2"')
    expect(profile).toContain('className="h-11 shrink-0 px-3 text-destructive hover:text-destructive sm:h-8"')
    expect(profile).toMatch(/data-testid=\{tid\.accountDeletionOpen\}[\s\S]*?>\s*Delete account\s*<\/Button>/u)
  })
})
