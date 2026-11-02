import source0 from "../channels/channel-route.tsx?raw"
import source1 from "../channels/dm-view.tsx?raw"
import source2 from "../channels/text-channel-surface.tsx?raw"
import source3 from "../channels/thread-channel-surface.dom.test.ts?raw"
import source4 from "../channels/thread-channel-surface.tsx?raw"
import source5 from "./create-forum-thread.tsx?raw"
import source6 from "./message-channel-controller.tsx?raw"
import { existsSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import * as facade from "./composer"

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..")
const sources: Record<string, string> = {
  "src/components/community/channels/channel-route.tsx": source0,
  "src/components/community/channels/dm-view.tsx": source1,
  "src/components/community/channels/text-channel-surface.tsx": source2,
  "src/components/community/channels/thread-channel-surface.dom.test.ts": source3,
  "src/components/community/channels/thread-channel-surface.tsx": source4,
  "src/components/community/messages/create-forum-thread.tsx": source5,
  "src/components/community/messages/message-channel-controller.tsx": source6,
}
const readWeb = (path: string) => {
  if (!(path in sources)) throw new Error("unregistered contract source: " + path)
  return sources[path]
}

describe("Composer facade boundaries", () => {
  it("exposes the public controls and file helpers without internal runtime exports", () => {
    expect(Object.keys(facade).sort()).toEqual([
      "Composer", "ComposerSkeleton", "clipboardFiles", "pendingFilesToSendAttachments",
    ])
    expect(existsSync(resolve(webRoot, "src/components/community/messages/index.ts"))).toBe(false)
  })

  it("keeps every direct importer on the facade and out of internals", () => {
    const importers = [
      "src/components/community/channels/dm-view.tsx",
      "src/components/community/channels/thread-channel-surface.tsx",
      "src/components/community/channels/channel-route.tsx",
      "src/components/community/channels/text-channel-surface.tsx",
      "src/components/community/messages/create-forum-thread.tsx",
      "src/components/community/messages/message-channel-controller.tsx",
      "src/components/community/channels/thread-channel-surface.dom.test.ts",
    ]
    for (const importer of importers) {
      const source = readWeb(importer)
      expect(source).toMatch(/(?:from|import\()\s*["'][^"']*\/composer["']/)
      expect(source).not.toMatch(
        /composer-(?:types|file-utils|view|suggestion-popups)|use-composer-(?:controller|suggestions)/,
      )
    }
  })

})
