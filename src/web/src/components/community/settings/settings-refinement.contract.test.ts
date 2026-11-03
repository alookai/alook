import source0 from "../../ui/confirm-dialog.tsx?raw"
import source1 from "../bots/bot-activity-modal.tsx?raw"
import source2 from "./field.tsx?raw"
import source3 from "./server-settings.tsx?raw"
import source4 from "./user-settings.tsx?raw"
import { describe, expect, it } from "vitest"

const sources: Record<string, string> = {
  "../../ui/confirm-dialog.tsx": source0,
  "../bots/bot-activity-modal.tsx": source1,
  "field.tsx": source2,
  "server-settings.tsx": source3,
  "user-settings.tsx": source4,
}
const readSettings = (path: string) => {
  if (!(path in sources)) throw new Error("unregistered contract source: " + path)
  return sources[path]
}

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

  it("keeps each form action group on its intended axis and preserves focus and contrast", () => {
    const user = readSettings("user-settings.tsx")
    const server = readSettings("server-settings.tsx")

    expect(user).toContain("flex flex-wrap items-center gap-x-4 gap-y-2")
    expect(user).toContain("ml-auto flex shrink-0 items-center gap-2")
    expect(server).toContain("items-center justify-start gap-2")
    expect(server).not.toContain("items-center justify-end gap-2")
    for (const source of [user, server]) {
      expect(source).toContain("focus-visible:ring-2")
      expect(source).not.toContain("placeholder:text-muted-foreground/40")
      expect(source).not.toContain("focus-visible:ring-0")
    }
    expect(user).not.toContain("text-muted-foreground/60\">Set a status")
    expect(user).not.toContain("text-muted-foreground/70")
  })

  it("keeps settings and log controls at least 44px tall on mobile", () => {
    const server = readSettings("server-settings.tsx")
    const activity = readSettings("../bots/bot-activity-modal.tsx")
    const confirm = readSettings("../../ui/confirm-dialog.tsx")

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
