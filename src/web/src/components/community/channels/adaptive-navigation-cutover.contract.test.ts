import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const readSource = (relativePath: string) =>
  readFileSync(new URL(relativePath, import.meta.url), "utf8")

describe("adaptive navigation cutover contracts", () => {
  it("uses the one flat route builder for known child entries and prefetches", () => {
    const contextSheet = readSource("../messages/message-context-sheet.tsx")
    const layout = readSource("../../../app/c/channels/layout.tsx")
    const sidebar = readSource("./channel-sidebar.tsx")

    expect(contextSheet).toContain(
      "push(channelHref(serverId, threadId))",
    )
    expect(contextSheet).not.toContain(
      "child" + "ChannelHref",
    )
    expect(layout).toContain("channelHref(serverId, id)")
    expect(sidebar).toContain("prefetchChannel?.(thread.id)")
    expect(sidebar).toContain("onSelectForumThread?.(thread.id)")
  })

  it("autofocuses message composers only after desktop is known", () => {
    const dmPage = readSource("../../../app/c/me/[dmId]/page.tsx")
    const textController = readSource("../../../modules/community/client/channel/internal/text-channel-controller.tsx")
    const threadSurface = readSource("./thread-channel-surface.tsx")

    expect(dmPage).toContain('autoFocus={bp === "desktop"}')
    expect(textController).toContain('autoFocus={breakpoint === "desktop"}')
    expect(threadSurface).toContain('autoFocus={breakpoint === "desktop"}')
  })
})
