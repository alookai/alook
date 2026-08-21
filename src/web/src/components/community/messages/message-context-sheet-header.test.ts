import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

describe("MessageContextSheet header", () => {
  it("supplies a structured title that truncates only the channel label", () => {
    const source = readFileSync(new URL("./message-context-sheet.tsx", import.meta.url), "utf8")

    expect(source).toContain("title={channelLabel ? (")
    expect(source).toContain('<span className="flex w-full min-w-0 items-center gap-1.5">')
    expect(source).toContain('<span className="min-w-0 truncate">{channelLabel}</span>')
    expect(source).toContain(
      '<span className="shrink-0 font-mono text-base font-normal text-muted-foreground">#{targetSeq ?? ""}</span>',
    )
    expect(source).not.toContain("CommunitySheetHeader")
    expect(source).not.toContain("CommunitySheetTitle")
  })
})
