import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import * as facade from "./message-list"

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..")
const source = (path: string) => readFileSync(resolve(webRoot, path), "utf8")

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
