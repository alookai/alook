import { existsSync, readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const readSource = (relativePath: string) =>
  readFileSync(new URL(relativePath, import.meta.url), "utf8")

describe("adaptive navigation cutover contracts", () => {
  it("uses the one flat route builder while preserving parent-aware sidebar callbacks", () => {
    const contextSheet = readSource("../messages/message-context-sheet.tsx")
    const layout = readSource("../shell/server-sidebar-slot.tsx")
    const sidebar = readSource("./channel-sidebar.tsx")

    expect(contextSheet).toContain(
      "push(channelHref(serverId, threadId))",
    )
    expect(contextSheet).not.toContain(
      "child" + "ChannelHref",
    )
    expect(layout).toContain("channelHref(serverId, id)")
    expect(sidebar).toContain("onSelectForumThread?.(parentId, thread.id)")
  })

  it("keeps the layout as the one channel subtree owner and removes the nested leaf", () => {
    const layout = readSource("../../../app/c/channels/layout.tsx")
    const flatPage = readSource("../../../app/c/channels/[serverId]/[channelId]/page.tsx")
    const nestedPage = new URL(
      "../../../app/c/channels/[serverId]/[channelId]/[childChannelId]/page.tsx",
      import.meta.url,
    )

    expect(layout).toContain(
      'import { ChannelRoute } from "@/components/community/channels/channel-route"',
    )
    expect(layout).toContain("key={JSON.stringify([currentUser.id, serverId])}")
    expect(layout).not.toContain("parentChannelId={routeParent" + "ChannelId}")
    expect(flatPage).toContain("return null")
    expect(flatPage).not.toContain("<ChannelRoute")
    expect(existsSync(nestedPage)).toBe(false)
  })

  it("autofocuses DM and thread composers only after desktop is known", () => {
    const dmPage = readSource("./dm-view.tsx")
    const threadSurface = readSource("./thread-channel-surface.tsx")

    expect(dmPage).toContain('autoFocus={bp === "desktop"}')
    expect(threadSurface).toContain('autoFocus={breakpoint === "desktop"}')
  })
})
