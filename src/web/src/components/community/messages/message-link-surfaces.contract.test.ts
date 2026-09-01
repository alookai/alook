import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..")
const source = (path: string) => readFileSync(resolve(webRoot, path), "utf8")

describe("Community ordinary-link action surface contract", () => {
  it("routes DM, channel, and thread timeline messages through one Message boundary", () => {
    for (const path of [
      "src/app/c/me/[dmId]/page.tsx",
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
      "src/app/c/me/[dmId]/page.tsx",
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
