import conversationScrollSource from "../../../hooks/community/use-conversation-scroll.ts?raw"
import reactOptionsSource from "../../../hooks/community/virtualizer-react-options.ts?raw"
import contractText0 from "../channels/forum-post-list.tsx?raw"
import contractText1 from "../members/member-list.tsx?raw"
import contractText2 from "../settings/server-settings.tsx?raw"
import contractText3 from "./message-list.tsx?raw"
import contractText4 from "./virtual-cursor-list.tsx?raw"
import contractText5 from "../bots/bot-activity-modal.tsx?raw"
import messageListViewSource from "./message-list-view.tsx?raw"
import { describe, expect, it, vi } from "vitest"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import type { ReactVirtualizer } from "@tanstack/react-virtual"
import { VirtualRows } from "./virtual-cursor-list"

const contractSources: Record<string, string> = {
  "../channels/forum-post-list.tsx": contractText0,
  "../members/member-list.tsx": contractText1,
  "../settings/server-settings.tsx": contractText2,
  "message-list.tsx": contractText3,
  "virtual-cursor-list.tsx": contractText4,
  "../bots/bot-activity-modal.tsx": contractText5,
}
const readComponent = (path: string) => {
  if (!(path in contractSources)) throw new Error("unregistered contract source: " + path)
  return contractSources[path]
}

describe("community virtualizer direct DOM contract", () => {
  const virtualRows = readComponent("virtual-cursor-list.tsx")

  it("renders MessageList with a native bottom-anchored flex scroller and no VirtualRows loop", () => {
    const messageList = readComponent("message-list.tsx")

    expect(messageList).not.toContain("<VirtualRows")
    expect(messageList).not.toContain("reactLayout")
    expect(messageList).toContain("data-message-rows")
    expect(messageList).toContain("mt-auto flex w-full flex-col")
    expect(messageListViewSource).not.toContain("justify-end")
    expect(conversationScrollSource).not.toContain("useVirtualizer")
    expect(conversationScrollSource).toContain("pinned-to-bottom")
    expect(conversationScrollSource).toContain("reading-history")
    expect(conversationScrollSource).toContain("jumping-to-target")
    expect(reactOptionsSource).toContain("useFlushSync: false")
    expect(reactOptionsSource).toContain("directDomUpdates: true")
  })

  it("keeps VirtualRows strictly on direct DOM updates without SSR height or transform writers", () => {
    const getTotalSize = vi.fn(() => {
      throw new Error("Direct layout cannot read total size")
    })
    const start = vi.fn(() => {
      throw new Error("Direct layout cannot read row position")
    })
    const virtualizer = {
      containerRef: vi.fn(),
      measureElement: vi.fn(),
      options: { directDomUpdates: true, scrollMargin: 10 },
      getTotalSize,
      getVirtualItems: () => [{ key: "row", index: 0, get start() { return start() } }],
    } as unknown as ReactVirtualizer<HTMLDivElement, Element>
    const html = renderToStaticMarkup(createElement(VirtualRows<string>, {
      items: ["Body"], virtualizer, renderItem: item => item,
    }))
    expect(html).toContain("Body")
    expect(getTotalSize).not.toHaveBeenCalled()
    expect(start).not.toHaveBeenCalled()
    expect(html).not.toContain("height:")
    expect(html).not.toContain("transform:")
    expect(html).not.toContain('role="list"')

    const listHtml = renderToStaticMarkup(createElement(VirtualRows<string>, {
      items: ["Body"], virtualizer, rowRole: "listitem", renderItem: item => item,
    }))
    expect(listHtml).toContain('role="list"')
    expect(listHtml).toContain('role="listitem"')
  })

  it("keeps ForumView on the shared direct DOM row contract", () => {
    const forumView = readComponent("../channels/forum-post-list.tsx")

    expect(forumView).toContain("...COMMUNITY_VIRTUALIZER_REACT_OPTIONS")
    expect(forumView).toContain("<VirtualRows")
    expect(forumView).not.toContain("reactLayout")
    expect(forumView).not.toContain("forumRangeExtractor")
    expect(forumView).not.toContain('querySelectorAll<HTMLElement>("[data-index]")')
    expect(virtualRows).toContain("ref={bindContainer}")
    expect(virtualRows).toContain("virtualizer.containerRef(node)")
    expect(virtualRows).toContain("ref={virtualizer.measureElement}")
  })

  it("gives MemberList container size and row position ownership to the virtualizer", () => {
    const memberList = readComponent("../members/member-list.tsx")

    expect(memberList).toContain("...COMMUNITY_VIRTUALIZER_REACT_OPTIONS")
    expect(memberList).toContain("<VirtualRows")
    expect(memberList).not.toContain("reactLayout")
    expect(memberList).toContain("virtualizer={rowVirtualizer}")
    expect(memberList).toContain("useCallback((index: number) => items[index]?.key ?? index, [items])")
    expect(memberList).toContain("paddingStart: 16")
    expect(memberList).toContain("paddingEnd: 16")
    expect(memberList).not.toContain("rowVirtualizer.getTotalSize()")
    expect(memberList).not.toContain("virtualRow.start")
  })

  it("gives SettingsMembers container size and row position ownership to the virtualizer", () => {
    const serverSettings = readComponent("../settings/server-settings.tsx")

    expect(serverSettings).toContain("...COMMUNITY_VIRTUALIZER_REACT_OPTIONS")
    expect(serverSettings).toContain("<VirtualRows")
    expect(serverSettings).not.toContain("reactLayout")
    expect(serverSettings).toContain("virtualizer={rowVirtualizer}")
    expect(serverSettings).toContain("useCallback((index: number) => members[index]?.id ?? index, [members])")
    expect(serverSettings).not.toContain("rowVirtualizer.getTotalSize()")
    expect(serverSettings).not.toContain("virtualRow.start")
  })

  it("gives BotActivityModal container size, row position, and safe item key ownership to the virtualizer", () => {
    const botActivityModal = readComponent("../bots/bot-activity-modal.tsx")

    expect(botActivityModal).toContain("...COMMUNITY_VIRTUALIZER_REACT_OPTIONS")
    expect(botActivityModal).toContain("<VirtualRows")
    expect(botActivityModal).not.toContain("reactLayout")
    expect(botActivityModal).toContain("virtualizer={virtualizer}")
    expect(botActivityModal).toContain("chronological[index]?.id ?? index")
    expect(botActivityModal).not.toContain("virtualizer.getTotalSize()")
    expect(botActivityModal).not.toContain("virtualRow.start")
  })
})
