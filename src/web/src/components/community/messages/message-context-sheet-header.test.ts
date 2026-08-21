import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

describe("MessageContextSheet header", () => {
  it("reserves the close-button lane while truncating only the channel label", () => {
    const source = readFileSync(new URL("./message-context-sheet.tsx", import.meta.url), "utf8")

    expect(source).toContain(
      '<CommunitySheetHeader className="gap-0 border-b-0 py-3 pr-14 sm:pr-14">',
    )
    expect(source).toContain(
      '<CommunitySheetTitle className="flex w-full min-w-0 items-center gap-1.5 text-lg font-semibold tracking-tight">',
    )
    expect(source).toContain('<span className="min-w-0 truncate">{channelLabel}</span>')
    expect(source).toContain(
      '<span className="shrink-0 font-mono text-base font-normal text-muted-foreground">#{targetSeq ?? ""}</span>',
    )
  })
})
