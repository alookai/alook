import { describe, it, expect } from "vitest"
import { insertMessageIntoCache } from "./use-community-ws"
import type { CommunityMessageCreate } from "@alook/shared"

// `insertMessageIntoCache` is a pure cache-patch function (no React), so it
// can be imported and tested directly — no need for the file's heavy React
// shim. The image-attachment branch is one of the silent-drop sites flagged
// in plans/attachment-image-dimensions.md's plan review.
describe("insertMessageIntoCache — attachment width/height", () => {
  const emptyCache = { pages: [{ messages: [] }], pageParams: [null] }

  function baseMessage(overrides: Partial<CommunityMessageCreate["message"]> = {}): CommunityMessageCreate["message"] {
    return {
      id: "msg_1",
      type: "chat",
      authorId: "author_1",
      authorName: "Author",
      authorAvatar: "A",
      content: "hello",
      createdAt: "2026-01-01T00:00:00.000Z",
      ...overrides,
    }
  }

  it("carries width/height through onto an image attachment", () => {
    const msg = baseMessage({
      attachments: [
        { id: "a1", filename: "a.png", url: "/a.png", contentType: "image/png", size: 1000, width: 1920, height: 1080 },
      ],
    })
    const result = insertMessageIntoCache(emptyCache as never, msg)
    const inserted = result?.pages[0].messages[0]
    expect(inserted?.attachments).toEqual([
      { kind: "image", name: "a.png", url: "/a.png", width: 1920, height: 1080 },
    ])
  })

  it("leaves width/height undefined for an image attachment with no dimensions on the payload", () => {
    const msg = baseMessage({
      attachments: [
        { id: "a1", filename: "a.png", url: "/a.png", contentType: "image/png", size: 1000 },
      ],
    })
    const result = insertMessageIntoCache(emptyCache as never, msg)
    const inserted = result?.pages[0].messages[0]
    expect(inserted?.attachments).toEqual([
      { kind: "image", name: "a.png", url: "/a.png", width: undefined, height: undefined },
    ])
  })

  it("never adds width/height to a file-kind attachment", () => {
    const msg = baseMessage({
      attachments: [
        { id: "a1", filename: "a.pdf", url: "/a.pdf", contentType: "application/pdf", size: 2048, width: 1920, height: 1080 },
      ],
    })
    const result = insertMessageIntoCache(emptyCache as never, msg)
    const inserted = result?.pages[0].messages[0]
    expect(inserted?.attachments).toEqual([
      { kind: "file", name: "a.pdf", url: "/a.pdf", size: "2 KB" },
    ])
  })
})
