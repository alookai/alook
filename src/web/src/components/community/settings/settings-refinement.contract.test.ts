import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const settingsDirectory = dirname(fileURLToPath(import.meta.url))
const readSettings = (file: string) => readFileSync(resolve(settingsDirectory, file), "utf8")

describe("settings refinement", () => {
  it("shows only the injected Web version as quiet Advanced footer metadata", () => {
    const source = readSettings("user-settings.tsx")

    expect(source).toContain("process.env.NEXT_PUBLIC_APP_VERSION")
    expect(source).toContain("data-testid={tid.settingsWebVersion}")
    expect(source).toContain("Web v{webVersion}")
    expect(source).toContain("font-mono text-xs tabular-nums")
    expect(source).toContain("{webVersion ? (")
  })

  it("uses one frameless rhythm and mobile-safe controls in User and Server settings", () => {
    const user = readSettings("user-settings.tsx")
    const server = readSettings("server-settings.tsx")

    expect(user).toContain("max-w-md space-y-8")
    expect(server).toContain("max-w-md space-y-8")
    expect(user).toContain('className="h-11 sm:h-8"')
    expect(server).toContain('className="h-11 sm:h-8"')
    expect(user).toContain("rounded-xl bg-muted/60 p-1")
    expect(user).not.toContain("rounded-lg border p-4")
  })

  it("keeps form actions on the content axis and preserves focus and readable contrast", () => {
    const user = readSettings("user-settings.tsx")
    const server = readSettings("server-settings.tsx")

    for (const source of [user, server]) {
      expect(source).toContain("items-center justify-start gap-2")
      expect(source).not.toContain("items-center justify-end gap-2")
      expect(source).toContain("focus-visible:ring-2")
      expect(source).not.toContain("placeholder:text-muted-foreground/40")
      expect(source).not.toContain("focus-visible:ring-0")
    }
    expect(user).not.toContain("text-muted-foreground/60\">Set a status")
    expect(user).not.toContain("text-muted-foreground/70")
  })

  it("keeps settings and log controls at least 44px tall on mobile", () => {
    const server = readSettings("server-settings.tsx")
    const activity = readFileSync(resolve(settingsDirectory, "../bots/bot-activity-modal.tsx"), "utf8")
    const confirm = readFileSync(resolve(settingsDirectory, "../../ui/confirm-dialog.tsx"), "utf8")

    expect(server).toContain("grid size-11 shrink-0")
    expect(server).toContain("size-11 text-muted-foreground hover:text-destructive")
    expect(activity).toContain("min-h-11 rounded-md")
    expect(confirm.match(/className="h-11 sm:h-7"/g)).toHaveLength(2)
  })

  it("labels the theme choices as a semantic group without merging button names", () => {
    const field = readSettings("field.tsx")

    expect(field).toContain('<fieldset className="min-w-0">')
    expect(field).toContain('<legend className="mb-1.5 text-xs text-muted-foreground">')
    expect(field).not.toContain('<label className="block">')
  })
})
