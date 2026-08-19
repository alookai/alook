import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const readSource = (relativePath: string) =>
  readFileSync(new URL(relativePath, import.meta.url), "utf8")

describe("adaptive navigation cutover contracts", () => {
  it("uses canonical parent-aware routes for known child entries and prefetches", () => {
    const contextSheet = readSource("../messages/message-context-sheet.tsx")
    const layout = readSource("../../../app/c/channels/layout.tsx")
    const sidebar = readSource("./channel-sidebar.tsx")

    expect(contextSheet).toContain(
      "router.push(childChannelHref(serverId, channelId, threadId))",
    )
    expect(contextSheet).not.toContain(
      "router.push(`/c/channels/${serverId}/${threadId}`)",
    )
    expect(layout).toContain("childChannelHref(serverId, parentId, id)")
    expect(sidebar).toContain("prefetchChannel?.(thread.id, parentId)")
  })

  it("autofocuses message composers only after desktop is known", () => {
    const dmPage = readSource("../../../app/c/me/[dmId]/page.tsx")
    const textSurface = readSource("./text-channel-surface.tsx")
    const threadSurface = readSource("./thread-channel-surface.tsx")

    expect(dmPage).toContain('autoFocus={bp === "desktop"}')
    expect(textSurface).toContain('autoFocus={breakpoint === "desktop"}')
    expect(threadSurface).toContain('autoFocus={breakpoint === "desktop"}')
  })
})
