import { describe, expect, it, vi } from "vitest"
import { createPendingAttachment } from "../../src/db/queries/community/attachment"

function database() {
  const chain: any = {}
  chain.values = vi.fn((value) => {
    chain.value = value
    return chain
  })
  chain.returning = vi.fn(async () => [{ ...chain.value, id: chain.value.id ?? "generated" }])
  return { insert: vi.fn(() => chain), chain }
}

describe("community attachment thumbnail persistence", () => {
  it("preserves an exact thumbnail key without changing the original", async () => {
    const db = database()
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
    const db = database()
    const row = await createPendingAttachment(db as any, {
      id: "a1", uploaderId: "u1", targetId: "c1", r2Key: "original-key", filename: "file.txt",
    })
    expect(row.thumbnailR2Key).toBeNull()
  })
})
