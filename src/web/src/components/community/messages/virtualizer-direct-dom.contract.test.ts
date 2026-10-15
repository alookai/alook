import { describe, expect, it, vi } from "vitest"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import type { ReactVirtualizer } from "@tanstack/react-virtual"
import { VirtualRows } from "./virtual-cursor-list"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const componentDirectory = path.dirname(fileURLToPath(import.meta.url))
const hooksDirectory = path.resolve(componentDirectory, "../../../hooks/community")
const readComponent = (name: string) => fs.readFileSync(path.join(componentDirectory, name), "utf8")

describe("community virtualizer direct DOM contract", () => {
  const virtualRows = readComponent("virtual-cursor-list.tsx")

  it("gives MessageList one React geometry writer with native direct updates disabled", () => {
    const messageList = readComponent("message-list.tsx")
    const scrollAnchor = fs.readFileSync(path.join(hooksDirectory, "use-scroll-anchor.ts"), "utf8")

    expect(messageList).toContain("<VirtualRows")
    expect(scrollAnchor).toContain("...COMMUNITY_VIRTUALIZER_REACT_OPTIONS")
    expect(virtualRows).toContain("ref={virtualizer.containerRef}")
    expect(virtualRows).toContain("ref={virtualizer.measureElement}")
    expect(messageList).toMatch(/<VirtualRows\s+reactLayout/)
    expect(scrollAnchor).toMatch(/\.\.\.COMMUNITY_VIRTUALIZER_REACT_OPTIONS,\s+directDomUpdates: false/)
    expect(scrollAnchor).toContain("initialRect:")
    expect(fs.readFileSync(path.join(hooksDirectory, "virtualizer-react-options.ts"), "utf8")).toContain("directDomUpdates: true")
  })

  it.each([false, true])("writes SSR height and transforms only for React layout=%s", (reactLayout) => {
    const getTotalSize = vi.fn(() => {
      if (!reactLayout) throw new Error("Direct layout cannot read total size")
      return 120
    })
    const start = vi.fn(() => {
      if (!reactLayout) throw new Error("Direct layout cannot read row position")
      return 40
    })
    const virtualizer = {
      containerRef: vi.fn(),
      measureElement: vi.fn(),
      options: { directDomUpdates: !reactLayout, scrollMargin: 10 },
      getTotalSize,
      getVirtualItems: () => [{ key: "row", index: 0, get start() { return start() } }],
    } as unknown as ReactVirtualizer<HTMLDivElement, Element>
    const html = renderToStaticMarkup(createElement(VirtualRows<string>, {
      items: ["Body"], virtualizer, reactLayout, renderItem: item => item,
    }))
    expect(html).toContain("Body")
    if (reactLayout) {
      expect(getTotalSize).toHaveBeenCalledOnce()
      expect(start).toHaveBeenCalledOnce()
      expect(html).toContain("height:120px")
      expect(html).toContain("translate3d(0, 30px, 0)")
    } else {
      expect(getTotalSize).not.toHaveBeenCalled()
      expect(start).not.toHaveBeenCalled()
      expect(html).not.toContain("height:")
      expect(html).not.toContain("transform:")
    }
  })

  it("keeps ForumView on the shared direct DOM row contract", () => {
    const forumView = readComponent("../channels/forum-view.tsx")

    expect(forumView).toContain("...COMMUNITY_VIRTUALIZER_REACT_OPTIONS")
    expect(forumView).toContain("<VirtualRows")
    expect(forumView).not.toContain("reactLayout")
    expect(virtualRows).toContain("ref={virtualizer.containerRef}")
    expect(virtualRows).toContain("ref={virtualizer.measureElement}")
  })

  it("gives MemberList container size and row position ownership to the virtualizer", () => {
    const memberList = readComponent("../members/member-list.tsx")

    expect(memberList).toContain("...COMMUNITY_VIRTUALIZER_REACT_OPTIONS")
    expect(memberList).toContain("<VirtualRows")
    expect(memberList).not.toContain("reactLayout")
    expect(memberList).toContain("virtualizer={rowVirtualizer}")
    expect(memberList).toContain("useCallback((index: number) => items[index]?.key ?? index, [items])")
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
})
