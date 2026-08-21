import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const migrations = [
  ["./community-panel-sheet.tsx", "sidecar"],
  ["../messages/message-context-sheet.tsx", "sidecar"],
  ["../messages/attachment-preview-sheet.tsx", "preview"],
  ["../bots/create-bot-sheet.tsx", "task"],
  ["../bots/edit-bot-sheet.tsx", "task"],
  ["../machines/pair-machine-sheet.tsx", "task"],
] as const

describe("CommunitySheet migrations", () => {
  it.each(migrations)("routes %s through the controlled %s shell", (path, mode) => {
    const source = readFileSync(new URL(path, import.meta.url), "utf8")

    expect(source).toContain("@/components/community/shell/community-sheet")
    expect(source).toContain(`mode="${mode}"`)
    expect(source).not.toContain("@/components/ui/sheet")
    expect(source).not.toContain("@/components/ui/sheet-resize-handle")
    expect(source).not.toContain('width="')
    expect(source).not.toContain("resizable")
  })

  it("does not expose per-feature width overrides", () => {
    for (const [path] of migrations) {
      const source = readFileSync(new URL(path, import.meta.url), "utf8")
      expect(source).not.toContain("initialWidth=")
    }
  })

  it("leaves AttachmentPreview with one wrapper-owned close entry", () => {
    const source = readFileSync(
      new URL("../messages/attachment-preview-sheet.tsx", import.meta.url),
      "utf8",
    )

    expect(source).toContain('closeLabel="Close attachment preview"')
    expect(source).not.toContain("ArrowLeft")
    expect(source).not.toContain("<X")
  })
})
