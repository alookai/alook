import { describe, it, expect } from "vitest"
import { groupAttachments, buildSinceResponse } from "./messages"
import { presentMessageAttachment } from "./attachment-presentation"

// A since response is a forward delta, but it can land as the sole/oldest page
// in the cache (reconnect install, persister rehydrate). The client reads the
// older-side signal off the oldest page, so a since page MUST carry one or
// scroll-up dies and pre-delta history becomes unreachable (the DM-history
// bug). It reports the older edge honestly: the delta's oldest row is `since`+1,
// so everything at/before `since` is provably older.
describe("buildSinceResponse", () => {
  const row = (id: string, createdAt: string) => ({ id, createdAt })

  it("emits hasMoreOlder + olderCursor on a non-empty delta", () => {
    const rows = [
      row("m_1", "2026-07-01T00:00:01.000Z"),
      row("m_2", "2026-07-01T00:00:02.000Z"),
    ]
    const res = buildSinceResponse(rows, 10)
    expect(res.hasMoreOlder).toBe(true)
    // olderCursor points at the OLDEST returned row (items[0]).
    expect(res.olderCursor).toBe("2026-07-01T00:00:01.000Z|m_1")
    // newerCursor is absent — no probe row means no more newer.
    expect(res.hasMoreNewer).toBe(false)
    expect(res.newerCursor).toBeUndefined()
  })

  it("fabricates no older signal on an empty delta", () => {
    const res = buildSinceResponse([], 10)
    expect(res.hasMoreOlder).toBe(false)
    expect(res.olderCursor).toBeUndefined()
    expect(res.items).toHaveLength(0)
  })

  it("keeps the newer-side probe/slice while adding the older signal", () => {
    // pageSize 2 with 3 rows → hasMoreNewer true, probe sliced off, olderCursor
    // still keyed on the oldest KEPT row (not the dropped probe).
    const rows = [
      row("m_1", "2026-07-01T00:00:01.000Z"),
      row("m_2", "2026-07-01T00:00:02.000Z"),
      row("m_3", "2026-07-01T00:00:03.000Z"),
    ]
    const res = buildSinceResponse(rows, 2)
    expect(res.items.map((r) => r.id)).toEqual(["m_1", "m_2"])
    expect(res.hasMoreNewer).toBe(true)
    expect(res.newerCursor).toBe("2026-07-01T00:00:02.000Z|m_2")
    expect(res.hasMoreOlder).toBe(true)
    expect(res.olderCursor).toBe("2026-07-01T00:00:01.000Z|m_1")
  })
})

describe("groupAttachments", () => {
  it("retains stable IDs, attachment order, raw metadata and declared thumbnail URLs", () => {
    const result = groupAttachments([
      { id: "att-b", messageId: "m1", targetId: "c1", filename: "photo.png", r2Key: "original", thumbnailR2Key: "thumb", contentType: "image/png", size: 1000, width: 1920, height: 1080 },
      { id: "att-a", messageId: "m1", targetId: "c1", filename: "unknown.bin", r2Key: "legacy", thumbnailR2Key: null, contentType: null, size: null, width: null, height: null },
    ])
    expect(result.m1).toEqual([
      { id: "att-b", name: "photo.png", url: "/api/community/channels/c1/attachments/att-b", thumbnailUrl: "/api/community/channels/c1/attachments/att-b/thumbnail", contentType: "image/png", sizeBytes: 1000, width: 1920, height: 1080 },
      { id: "att-a", name: "unknown.bin", url: "/api/community/channels/c1/attachments/att-a", thumbnailUrl: null, contentType: null, sizeBytes: null, width: null, height: null },
    ])
    expect(result.m1?.[0]).not.toHaveProperty("kind")
    expect(result.m1?.[1]).not.toHaveProperty("size")
  })

  it("retains file dimensions while formatting them only for the read view", () => {
    const raw = groupAttachments([{ id: "att1", messageId: "m1", targetId: "c1", filename: "a.pdf", r2Key: "key", contentType: "application/pdf", size: 2048, width: 1920, height: 1080 }]).m1![0]!
    expect(raw).toMatchObject({ id: "att1", width: 1920, height: 1080, sizeBytes: 2048, thumbnailUrl: null })
    expect(presentMessageAttachment(raw)).toEqual({ kind: "file", name: "a.pdf", url: "/api/community/channels/c1/attachments/att1", contentType: "application/pdf", sizeBytes: 2048, size: "2.0 KB" })
  })

  it.each(["image/svg+xml", "image/x-forged"])("preserves unsafe %s metadata and renders a file", (contentType) => {
    const raw = groupAttachments([{ id: "att1", messageId: "m1", targetId: "c1", filename: "unsafe.img", r2Key: "key", contentType, size: 2048, width: 1920, height: 1080 }]).m1![0]!
    expect(raw).toMatchObject({ id: "att1", contentType, width: 1920, height: 1080 })
    expect(presentMessageAttachment(raw)).toMatchObject({ kind: "file", size: "2.0 KB" })
  })

  it("skips pending attachments without losing a linked row's NULL metadata", () => {
    const result = groupAttachments([
      { id: "att0", messageId: null, targetId: "c1", filename: "pending.png", r2Key: "pending", contentType: "image/png", size: 100, width: null, height: null },
      { id: "att1", messageId: "m1", targetId: "c1", filename: "linked.png", r2Key: "linked", contentType: "image/png", size: 100, width: null, height: null },
    ])
    expect(Object.keys(result)).toEqual(["m1"])
    expect(result.m1).toEqual([{ id: "att1", name: "linked.png", url: "/api/community/channels/c1/attachments/att1", thumbnailUrl: null, contentType: "image/png", sizeBytes: 100, width: null, height: null }])
  })
})
