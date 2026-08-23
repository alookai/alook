import { describe, expect, it, vi } from "vitest"
import { createPendingAttachment } from "../../src/db/queries/community/attachment"

function database(row: Record<string, unknown> | null) {
  const candidate: any = {}
  candidate.from = vi.fn(() => candidate)
  candidate.where = vi.fn(() => candidate)
  candidate.limit = vi.fn(() => candidate)
  const insert: any = {}
  insert.select = vi.fn(() => insert)
  insert.returning = vi.fn(async () => row ? [row] : [])
  return {
    select: vi.fn(() => candidate),
    insert: vi.fn(() => insert),
    candidate,
    insertChain: insert,
  }
}

describe("community attachment thumbnail persistence", () => {
  it("preserves an exact thumbnail key without changing the original", async () => {
    const db = database({
      id: "a1", uploaderId: "u1", targetId: "c1", r2Key: "original-key",
      thumbnailR2Key: "original-key.thumbnail.jpg", filename: "photo.png", messageId: null,
    })
    const row = await createPendingAttachment(db as any, {
      id: "a1", uploaderId: "u1", targetId: "c1", r2Key: "original-key",
      thumbnailR2Key: "original-key.thumbnail.jpg", filename: "photo.png",
    })
    expect(row).toMatchObject({
      r2Key: "original-key",
      thumbnailR2Key: "original-key.thumbnail.jpg",
      messageId: null,
    })
  })

  it("writes null for legacy/original-only uploads", async () => {
    const db = database({
      id: "a1", uploaderId: "u1", targetId: "c1", r2Key: "original-key",
      thumbnailR2Key: null, filename: "file.txt", messageId: null,
    })
    const row = await createPendingAttachment(db as any, {
      id: "a1", uploaderId: "u1", targetId: "c1", r2Key: "original-key", filename: "file.txt",
    })
    expect(row.thumbnailR2Key).toBeNull()
  })

  it("throws when the target-exists INSERT SELECT returns no row", async () => {
    const db = database(null)
    await expect(createPendingAttachment(db as any, {
      id: "a1", uploaderId: "u1", targetId: "deleted", r2Key: "original-key", filename: "file.txt",
    })).rejects.toThrow("attachment target no longer exists")
    expect(db.insertChain.select).toHaveBeenCalledWith(db.candidate)
  })
})
