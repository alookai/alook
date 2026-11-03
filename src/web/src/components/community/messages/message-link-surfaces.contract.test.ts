import source0 from "../channels/dm-view.tsx?raw"
import source1 from "../channels/text-channel-surface.tsx?raw"
import source2 from "../channels/thread-channel-surface.tsx?raw"
import source3 from "./message-context-sheet.tsx?raw"
import source4 from "./message-list-row.tsx?raw"
import source5 from "./message-row.tsx?raw"
import source6 from "./message.tsx?raw"
import { describe, expect, it } from "vitest"

const sources: Record<string, string> = {
  "src/components/community/channels/dm-view.tsx": source0,
  "src/components/community/channels/text-channel-surface.tsx": source1,
  "src/components/community/channels/thread-channel-surface.tsx": source2,
  "src/components/community/messages/message-context-sheet.tsx": source3,
  "src/components/community/messages/message-list-row.tsx": source4,
  "src/components/community/messages/message-row.tsx": source5,
  "src/components/community/messages/message.tsx": source6,
}
const source = (path: string) => {
  if (!(path in sources)) throw new Error("unregistered contract source: " + path)
  return sources[path]
}

describe("Community ordinary-link action surface contract", () => {
  it("routes DM, channel, and thread timeline messages through one Message boundary", () => {
    for (const path of [
      "src/components/community/channels/dm-view.tsx",
      "src/components/community/channels/text-channel-surface.tsx",
      "src/components/community/channels/thread-channel-surface.tsx",
    ]) {
      expect(source(path), path).toContain("<MessageList")
    }
    expect(source("src/components/community/messages/message-list-row.tsx"))
      .toContain("<MessageRow")
    expect(source("src/components/community/messages/message-row.tsx"))
      .toContain("<Message")
  })

  it("routes message-context rows through the same MessageRow boundary", () => {
    const contextSheet = source("src/components/community/messages/message-context-sheet.tsx")
    expect(contextSheet).toContain("<MessageRow")
    expect(contextSheet).not.toContain("Copy Link")
    expect(contextSheet).not.toContain("Open Link")
  })

  it("keeps gesture target parsing and link-menu labels out of route-specific surfaces", () => {
    for (const path of [
      "src/components/community/channels/dm-view.tsx",
      "src/components/community/channels/text-channel-surface.tsx",
      "src/components/community/channels/thread-channel-surface.tsx",
      "src/components/community/messages/message-context-sheet.tsx",
      "src/components/community/messages/message-list-row.tsx",
      "src/components/community/messages/message-row.tsx",
    ]) {
      const text = source(path)
      expect(text, path).not.toContain("messageExternalLinkTargetFromEventTarget")
      expect(text, path).not.toContain("Copy Link")
      expect(text, path).not.toContain("Open Link")
    }

    const message = source("src/components/community/messages/message.tsx")
    expect(message).toContain("messageExternalLinkTargetFromEventTarget")
    expect(message).toContain("onClickCapture")
    expect(message).toContain("onContextMenuCapture")
  })
})
