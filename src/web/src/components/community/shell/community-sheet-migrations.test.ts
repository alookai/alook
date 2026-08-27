import { existsSync, readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const migrations = [
  "./community-panel.tsx",
  "../messages/message-context-sheet.tsx",
  "../messages/attachment-preview-sheet.tsx",
  "../bots/create-bot-sheet.tsx",
  "../bots/edit-bot-sheet.tsx",
  "../bots/bot-activity-modal.tsx",
  "../machines/pair-machine-sheet.tsx",
] as const

describe("CommunitySheet migrations", () => {
  it.each(migrations)("routes %s through the one structured modal shell", (path) => {
    const source = readFileSync(new URL(path, import.meta.url), "utf8")

    expect(source).toContain("@/components/community/shell/community-sheet")
    expect(source).toContain("<CommunitySheet")
    expect(source).toContain("title=")
    expect(source).not.toContain("@/components/ui/sheet")
    expect(source).not.toContain("@/components/ui/sheet-resize-handle")
    expect(source).not.toMatch(/mode="(?:sidecar|task|preview)"/)
    expect(source).not.toContain("initialWidth=")
    expect(source).not.toContain("headerActions")
    expect(source).not.toMatch(/CommunitySheet(?:Header|Body|Footer|Title|Description|Close)/)
  })

  it("allows only Attachment Preview and Activity Log to opt into resize", () => {
    for (const path of migrations) {
      const source = readFileSync(new URL(path, import.meta.url), "utf8")
      if (path.includes("attachment-preview") || path.includes("bot-activity")) {
        expect(source).toContain("resizable")
      }
      else expect(source).not.toContain("resizable")
    }
  })

  it("reserves explicit desktop widths for Members and Activity Log", () => {
    for (const path of migrations) {
      const source = readFileSync(new URL(path, import.meta.url), "utf8")
      if (path === "./community-panel.tsx") {
        expect(source).toContain('desktopWidth={kind === "members" ? 380 : undefined}')
      } else if (path.includes("bot-activity")) {
        expect(source).toContain("desktopWidth={672}")
      } else {
        expect(source).not.toContain("desktopWidth=")
      }
    }
  })

  it("collapses the community panel to one business layer", () => {
    const panel = readFileSync(new URL("./community-panel.tsx", import.meta.url), "utf8")
    expect(panel).toContain("export function CommunityPanel")
    expect(panel).not.toContain("RightPanelContent")
    expect(existsSync(new URL("./community-panel-sheet.tsx", import.meta.url))).toBe(false)
    expect(existsSync(new URL("./right-panel.tsx", import.meta.url))).toBe(false)
    expect(existsSync(new URL("./panel-shell.tsx", import.meta.url))).toBe(false)
  })

  it("leaves Attachment Preview with one wrapper-owned close entry", () => {
    const source = readFileSync(
      new URL("../messages/attachment-preview-sheet.tsx", import.meta.url),
      "utf8",
    )

    expect(source).toContain('closeLabel="Close attachment preview"')
    expect(source).not.toContain("ArrowLeft")
    expect(source).not.toContain("<X")
  })

  it("routes PairMachine footer close through the shell request", () => {
    const source = readFileSync(
      new URL("../machines/pair-machine-sheet.tsx", import.meta.url),
      "utf8",
    )
    expect(source).toContain("footer={(requestClose)")
    expect(source).toContain("onClick={requestClose}")
    expect(source).toContain('className="min-h-11!"')
    expect(source).not.toContain("CommunitySheetClose")
  })
})
