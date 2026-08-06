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

  it.each(["image/svg+xml", "image/x-forged"])(
    "materializes unsafe %s attachments as file-kind",
    (contentType) => {
      const msg = baseMessage({
        attachments: [
          { id: "a1", filename: "unsafe.img", url: "/unsafe.img", contentType, size: 2048, width: 1920, height: 1080 },
        ],
      })
      const result = insertMessageIntoCache(emptyCache as never, msg)
      const inserted = result?.pages[0].messages[0]
      expect(inserted?.attachments).toEqual([
        { kind: "file", name: "unsafe.img", url: "/unsafe.img", size: "2 KB" },
      ])
    },
  )
})

// reply-disappear root-cause fix (step 2): a message.create echo of the
// SENDER's own send carries the same clientNonce the optimistic row was stamped
// with (WS step 1), so `insertMessageIntoCache` reconciles that row IN PLACE
// (temp id → server id) instead of appending a duplicate. The duplicate was the
// 2-row transient that, collapsed under an unlucky POST-vs-WS ordering, made a
// just-sent reply vanish. These lock "one row, no double-insert" — the machine
// oracle for the fix (Ingaborg's dt=0 ADD,ADD → single ADD).
describe("insertMessageIntoCache — optimistic-row reconcile by clientNonce (reply-disappear step 2)", () => {
  const optimisticRow = {
    id: "temp_abc",
    type: "chat" as const,
    authorId: "author_1",
    authorName: "Author",
    content: "hello",
    createdAt: "2026-01-01T00:00:00.000Z",
    clientNonce: "nonce-xyz",
  }
  const cacheWithOptimistic = () => ({ pages: [{ messages: [{ ...optimisticRow }] }], pageParams: [null] })

  function echo(overrides: Partial<CommunityMessageCreate["message"]> = {}): CommunityMessageCreate["message"] {
    return {
      id: "msg_server_1",
      type: "chat",
      authorId: "author_1",
      authorName: "Author",
      authorAvatar: "A",
      content: "hello",
      createdAt: "2026-01-01T00:00:00.000Z",
      clientNonce: "nonce-xyz",
      ...overrides,
    } as CommunityMessageCreate["message"]
  }

  it("same-nonce echo renames the optimistic row in place (temp→server id) — ONE row, no duplicate", () => {
    const result = insertMessageIntoCache(cacheWithOptimistic() as never, echo())
    const rows = result?.pages[0].messages
    expect(rows).toHaveLength(1)
    expect(rows?.[0].id).toBe("msg_server_1")
    expect(rows?.[0].clientNonce).toBe("nonce-xyz")
    expect(rows?.[0].failed).toBe(false)
  })

  it("preserves the optimistic row's position (reconcile in place, not append)", () => {
    const older = { id: "m_old", type: "chat" as const, authorId: "a", authorName: "X", content: "prev", createdAt: "2025-12-31T00:00:00.000Z" }
    const cache = { pages: [{ messages: [older, { ...optimisticRow }] }], pageParams: [null] }
    const result = insertMessageIntoCache(cache as never, echo())
    const rows = result?.pages[0].messages
    expect(rows).toHaveLength(2)
    expect(rows?.map((m) => m.id)).toEqual(["m_old", "msg_server_1"])
  })

  it("an echo with a DIFFERENT nonce (someone else's message) is appended normally — no false reconcile", () => {
    const result = insertMessageIntoCache(cacheWithOptimistic() as never, echo({ id: "msg_other", clientNonce: "other-nonce" }))
    const rows = result?.pages[0].messages
    expect(rows).toHaveLength(2)
    expect(rows?.map((m) => m.id)).toEqual(["temp_abc", "msg_other"])
  })

  it("an echo with NO clientNonce (srv-fallback, never echoed anyway) is appended — no reconcile", () => {
    const result = insertMessageIntoCache(cacheWithOptimistic() as never, echo({ id: "msg_nononce", clientNonce: undefined }))
    const rows = result?.pages[0].messages
    expect(rows).toHaveLength(2)
    expect(rows?.map((m) => m.id)).toEqual(["temp_abc", "msg_nononce"])
  })

  it("the server-id dedup still wins first: a re-delivered echo (server id already present) is a no-op", () => {
    // After a prior reconcile the row already carries the server id; a duplicate
    // echo must not touch the cache (id check precedes the nonce reconcile).
    const cache = { pages: [{ messages: [{ ...optimisticRow, id: "msg_server_1" }] }], pageParams: [null] }
    const result = insertMessageIntoCache(cache as never, echo())
    expect(result?.pages[0].messages).toHaveLength(1)
    expect(result?.pages[0].messages[0].id).toBe("msg_server_1")
  })
})
