import { describe, it, expect } from "vitest"
import { groupAttachments, buildSinceResponse } from "./messages"

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

// `groupAttachments` derives the render `url` from the row's `targetId` + `id`
// via the shared `attachmentUrl` helper — the URL is id-addressed and served by
// the canonical `channels/{id}/attachments/{attachmentId}` door (route/disc
// attachments fold). The DB row carries no `url` column. `width`/`height` are
// optional on the output shape, so we assert on the actual returned object
// rather than relying on the declared type to catch a missing field.
describe("groupAttachments", () => {
  it("projects a canonical thumbnail URL only when the row declares one", () => {
    const result = groupAttachments([
      { id: "att1", messageId: "m1", targetId: "c1", filename: "a.png", r2Key: "original", thumbnailR2Key: "thumb", contentType: "image/png", size: 1000 },
      { id: "att2", messageId: "m2", targetId: "c1", filename: "legacy.png", r2Key: "legacy", thumbnailR2Key: null, contentType: "image/png", size: 1000 },
    ])
    expect(result.m1?.[0]).toMatchObject({
      url: "/api/community/channels/c1/attachments/att1",
      thumbnailUrl: "/api/community/channels/c1/attachments/att1/thumbnail",
    })
    expect(result.m2?.[0]).not.toHaveProperty("thumbnailUrl")
  })

  it("projects width/height onto an image-kind entry when present on the row", () => {
    const result = groupAttachments([
      { id: "att1", messageId: "m1", targetId: "c1", filename: "a.png", r2Key: "channel/c1/uuid/a.png", contentType: "image/png", size: 1000, width: 1920, height: 1080 },
    ])
    expect(result.m1).toEqual([
      { kind: "image", name: "a.png", url: "/api/community/channels/c1/attachments/att1", contentType: "image/png", sizeBytes: 1000, width: 1920, height: 1080 },
    ])
  })

  it("leaves width/height undefined on an image-kind entry when the row has none", () => {
    const result = groupAttachments([
      { id: "att1", messageId: "m1", targetId: "c1", filename: "a.png", r2Key: "channel/c1/uuid/a.png", contentType: "image/png", size: 1000, width: null, height: null },
    ])
    expect(result.m1).toEqual([
      { kind: "image", name: "a.png", url: "/api/community/channels/c1/attachments/att1", contentType: "image/png", sizeBytes: 1000, width: undefined, height: undefined },
    ])
  })

  it("never adds width/height to a file-kind entry, even if present on the row", () => {
    const result = groupAttachments([
      { id: "att1", messageId: "m1", targetId: "c1", filename: "a.pdf", r2Key: "channel/c1/uuid/a.pdf", contentType: "application/pdf", size: 2048, width: 1920, height: 1080 },
    ])
    expect(result.m1).toEqual([
      { kind: "file", name: "a.pdf", url: "/api/community/channels/c1/attachments/att1", contentType: "application/pdf", sizeBytes: 2048, size: "2.0 KB" },
    ])
  })

  it.each(["image/svg+xml", "image/x-forged"])(
    "materializes unsafe %s attachments as file-kind",
    (contentType) => {
      const result = groupAttachments([
        { id: "att1", messageId: "m1", targetId: "c1", filename: "unsafe.img", r2Key: "channel/c1/uuid/unsafe.img", contentType, size: 2048, width: 1920, height: 1080 },
      ])
      expect(result.m1).toEqual([
        { kind: "file", name: "unsafe.img", url: "/api/community/channels/c1/attachments/att1", contentType, sizeBytes: 2048, size: "2.0 KB" },
      ])
    },
  )

  it("skips pending rows (messageId=null) so agent-uploaded pending attachments never surface", () => {
    const result = groupAttachments([
      { id: "att0", messageId: null, targetId: "c1", filename: "pending.png", r2Key: "channel/c1/uuid/pending.png", contentType: "image/png", size: 100, width: null, height: null },
      { id: "att1", messageId: "m1", targetId: "c1", filename: "linked.png", r2Key: "channel/c1/uuid/linked.png", contentType: "image/png", size: 100, width: null, height: null },
    ])
    expect(result).toEqual({
      m1: [{ kind: "image", name: "linked.png", url: "/api/community/channels/c1/attachments/att1", contentType: "image/png", sizeBytes: 100, width: undefined, height: undefined }],
    })
  })
})
