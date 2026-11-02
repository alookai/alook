import source0 from "../channels/text-channel-surface.dom.test.ts?raw"
import source1 from "../channels/text-channel-surface.tsx?raw"
import source2 from "../channels/thread-channel-surface.dom.test.ts?raw"
import source3 from "../channels/thread-channel-surface.tsx?raw"
import source4 from "./message-channel-controller-actions.ts?raw"
import source5 from "./message-channel-controller-send.ts?raw"
import { describe, expect, it } from "vitest"
import * as facade from "./message-channel-controller"

const sources: Record<string, string> = {
  "src/components/community/channels/text-channel-surface.dom.test.ts": source0,
  "src/components/community/channels/text-channel-surface.tsx": source1,
  "src/components/community/channels/thread-channel-surface.dom.test.ts": source2,
  "src/components/community/channels/thread-channel-surface.tsx": source3,
  "src/components/community/messages/message-channel-controller-actions.ts": source4,
  "src/components/community/messages/message-channel-controller-send.ts": source5,
}
const source = (path: string) => {
  if (!(path in sources)) throw new Error("unregistered contract source: " + path)
  return sources[path]
}

describe("MessageChannelController facade boundaries", () => {
  it("exposes the public component without internal runtime exports", () => {
    expect(Object.keys(facade)).toEqual(["MessageChannelController"])
  })

  it("keeps production and test consumers on the original path", () => {
    const importers = [
      "src/components/community/channels/thread-channel-surface.tsx",
      "src/components/community/channels/text-channel-surface.tsx",
      "src/components/community/channels/thread-channel-surface.dom.test.ts",
      "src/components/community/channels/text-channel-surface.dom.test.ts",
    ]
    for (const path of importers) {
      const text = source(path)
      expect(text).toMatch(/message-channel-controller["']/)
      expect(text).not.toMatch(/message-channel-controller-(types|state|actions|send|view)/)
    }
  })

  it("keeps action and send helpers hook-free", () => {
    for (const helper of ["actions", "send"]) {
      expect(source(`src/components/community/messages/message-channel-controller-${helper}.ts`))
        .not.toMatch(/\buse[A-Z][A-Za-z]+\(/)
    }
  })
})
