import { existsSync, readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import * as facade from "./composer"

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..")
const readWeb = (path: string) => readFileSync(resolve(webRoot, path), "utf8")

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
