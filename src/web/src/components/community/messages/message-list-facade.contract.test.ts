import source0 from "../../../app/c/layout.tsx?raw"
import source1 from "../../../app/c/page.tsx?raw"
import source2 from "../channels/channel-loading-frame.tsx?raw"
import source3 from "../channels/conversation-surface.tsx?raw"
import source4 from "../channels/dm-view.tsx?raw"
import source5 from "../channels/text-channel-surface.tsx?raw"
import source6 from "../channels/thread-channel-surface.tsx?raw"
import { describe, expect, it } from "vitest"
import * as facade from "./message-list"

const sources: Record<string, string> = {
  "src/app/c/layout.tsx": source0,
  "src/app/c/page.tsx": source1,
  "src/components/community/channels/channel-loading-frame.tsx": source2,
  "src/components/community/channels/conversation-surface.tsx": source3,
  "src/components/community/channels/dm-view.tsx": source4,
  "src/components/community/channels/text-channel-surface.tsx": source5,
  "src/components/community/channels/thread-channel-surface.tsx": source6,
}
const source = (path: string) => {
  if (!(path in sources)) throw new Error("unregistered contract source: " + path)
  return sources[path]
}

describe("MessageList facade boundaries", () => {
  it("exposes the public component without internal runtime exports", () => {
    expect(Object.keys(facade)).toEqual(["MessageList"])
  })

  it("keeps the unified ConversationSurface on the MessageList facade and surfaces on ConversationSurface", () => {
    const surfaceSource = source("src/components/community/channels/conversation-surface.tsx")
    expect(surfaceSource).toMatch(/messages\/message-list["']/)
    expect(surfaceSource).not.toMatch(/message-list-(types|controller|view|row)/)

    const consumers = [
      "src/components/community/channels/dm-view.tsx",
      "src/components/community/channels/thread-channel-surface.tsx",
      "src/components/community/channels/text-channel-surface.tsx",
    ]
    for (const path of consumers) {
      const text = source(path)
      expect(text).toMatch(/conversation-surface["']/)
      expect(text).not.toMatch(/message-list-(types|controller|view|row)/)
    }
  })

  it("keeps unresolved server entries independent of message layout modules", () => {
    for (const path of [
      "src/app/c/page.tsx",
      "src/app/c/layout.tsx",
      "src/components/community/channels/channel-loading-frame.tsx",
    ]) {
      expect(source(path)).not.toMatch(/messages\/(?:message-list|composer)|[\/."](?:channel-header|conversation-surface)["']/)
    }
  })
})
