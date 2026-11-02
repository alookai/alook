import source0 from "../../../app/c/layout.tsx?raw"
import source1 from "../../../app/c/page.tsx?raw"
import source2 from "../channels/channel-loading-frame.tsx?raw"
import source3 from "../channels/dm-view.tsx?raw"
import source4 from "../channels/text-channel-surface.tsx?raw"
import source5 from "../channels/thread-channel-surface.tsx?raw"
import { describe, expect, it } from "vitest"
import * as facade from "./message-list"

const sources: Record<string, string> = {
  "src/app/c/layout.tsx": source0,
  "src/app/c/page.tsx": source1,
  "src/components/community/channels/channel-loading-frame.tsx": source2,
  "src/components/community/channels/dm-view.tsx": source3,
  "src/components/community/channels/text-channel-surface.tsx": source4,
  "src/components/community/channels/thread-channel-surface.tsx": source5,
}
const source = (path: string) => {
  if (!(path in sources)) throw new Error("unregistered contract source: " + path)
  return sources[path]
}

describe("MessageList facade boundaries", () => {
  it("exposes the public component without internal runtime exports", () => {
    expect(Object.keys(facade)).toEqual(["MessageList"])
  })

  it("keeps all production consumers on the original path", () => {
    const importers = [
      "src/components/community/channels/dm-view.tsx",
      "src/components/community/channels/thread-channel-surface.tsx",
      "src/components/community/channels/text-channel-surface.tsx",
    ]
    for (const path of importers) {
      const text = source(path)
      expect(text).toMatch(/messages\/message-list["']/)
      expect(text).not.toMatch(/message-list-(types|controller|view|row)/)
    }
  })

  it("keeps unresolved server entries independent of message layout modules", () => {
    for (const path of [
      "src/app/c/page.tsx",
      "src/app/c/layout.tsx",
      "src/components/community/channels/channel-loading-frame.tsx",
    ]) {
      expect(source(path)).not.toMatch(/messages\/(?:message-list|composer)|[\/."]channel-header["']/)
    }
  })
})
