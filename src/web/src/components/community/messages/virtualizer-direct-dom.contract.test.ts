import { describe, expect, it } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const componentDirectory = path.dirname(fileURLToPath(import.meta.url))
const hooksDirectory = path.resolve(componentDirectory, "../../../hooks/community")
const readComponent = (name: string) => fs.readFileSync(path.join(componentDirectory, name), "utf8")
const srcDirectory = path.resolve(componentDirectory, "../../..")
const readSource = (name: string) => fs.readFileSync(path.join(srcDirectory, name), "utf8")

describe("community virtualizer direct DOM contract", () => {
  const virtualRows = readSource("components/ui/virtual-rows.tsx")

  it("keeps MessageList on the shared direct DOM row contract", () => {
    const messageList = readSource("modules/community/client/messaging/message-list.tsx")
    const scrollAnchor = fs.readFileSync(path.join(hooksDirectory, "use-scroll-anchor.ts"), "utf8")

    expect(messageList).toContain("<VirtualRows")
    expect(scrollAnchor).toContain("...COMMUNITY_VIRTUALIZER_REACT_OPTIONS")
    expect(scrollAnchor).toContain("const size = measureMessageRow(element)")
    expect(virtualRows).toContain("ref={virtualizer.containerRef}")
    expect(virtualRows).toContain("ref={virtualizer.measureElement}")
    expect(virtualRows).not.toContain("virtualizer.getTotalSize()")
    expect(virtualRows).not.toContain("virtualRow.start")
  })

  it("keeps ForumView on the shared direct DOM row contract", () => {
    const forumView = readComponent("../channels/forum-view.tsx")

    expect(forumView).toContain("...COMMUNITY_VIRTUALIZER_REACT_OPTIONS")
    expect(forumView).toContain("<VirtualRows")
    expect(forumView).toContain('from "@/components/ui/virtual-rows"')
    expect(virtualRows).toContain("ref={virtualizer.containerRef}")
    expect(virtualRows).toContain("ref={virtualizer.measureElement}")
  })

  it("gives MemberList container size and row position ownership to the virtualizer", () => {
    const memberList = readComponent("../members/member-list.tsx")

    expect(memberList).toContain("...COMMUNITY_VIRTUALIZER_REACT_OPTIONS")
    expect(memberList).toContain("ref={rowVirtualizer.containerRef}")
    expect(memberList).toContain("ref={rowVirtualizer.measureElement}")
    expect(memberList).toContain("getItemKey: (index) => items[index]?.key ?? index")
    expect(memberList).not.toContain("rowVirtualizer.getTotalSize()")
    expect(memberList).not.toContain("virtualRow.start")
  })

  it("gives SettingsMembers container size and row position ownership to the virtualizer", () => {
    const serverSettings = readComponent("../settings/server-settings.tsx")

    expect(serverSettings).toContain("...COMMUNITY_VIRTUALIZER_REACT_OPTIONS")
    expect(serverSettings).toContain("ref={rowVirtualizer.containerRef}")
    expect(serverSettings).toContain("ref={rowVirtualizer.measureElement}")
    expect(serverSettings).toContain("getItemKey: (index) => members[index]?.id ?? index")
    expect(serverSettings).not.toContain("rowVirtualizer.getTotalSize()")
    expect(serverSettings).not.toContain("virtualRow.start")
  })
})
