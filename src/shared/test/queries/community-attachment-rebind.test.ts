import { describe, expect, it, vi } from "vitest"
import { rebindPendingAttachmentsToChild } from "../../src/db/queries/community/attachment"

function createDb(rows: Array<{ id: string; targetId: string }>) {
  const selectChain: any = {}
  selectChain.from = vi.fn(() => selectChain)
  selectChain.where = vi.fn(async () => rows)
  const updateChain: any = {}
  updateChain.set = vi.fn(() => updateChain)
  updateChain.where = vi.fn(async () => undefined)
  return {
    select: vi.fn(() => selectChain),
    update: vi.fn(() => updateChain),
    selectChain,
    updateChain,
  }
}

describe("rebindPendingAttachmentsToChild", () => {
  it("moves an eligible pending attachment to the direct child target", async () => {
    const db = createDb([{ id: "attachment_1", targetId: "forum_1" }])

    const result = await rebindPendingAttachmentsToChild(db as any, {
      ids: ["attachment_1"],
      uploaderId: "user_1",
      parentTargetId: "forum_1",
      childTargetId: "thread_1",
    })

    expect(result).toBe(true)
    expect(db.updateChain.set).toHaveBeenCalledWith({ targetId: "thread_1" })
  })

  it("accepts an attachment already pending on the same child for replay", async () => {
    const db = createDb([{ id: "attachment_1", targetId: "thread_1" }])

    const result = await rebindPendingAttachmentsToChild(db as any, {
      ids: ["attachment_1"],
      uploaderId: "user_1",
      parentTargetId: "forum_1",
      childTargetId: "thread_1",
    })

    expect(result).toBe(true)
  })

  it("rejects the whole set when any requested attachment is outside the scoped pending rows", async () => {
    const db = createDb([{ id: "attachment_1", targetId: "forum_1" }])

    const result = await rebindPendingAttachmentsToChild(db as any, {
      ids: ["attachment_1", "sibling_or_foreign_attachment"],
      uploaderId: "user_1",
      parentTargetId: "forum_1",
      childTargetId: "thread_1",
    })

    expect(result).toBe(false)
    expect(db.update).not.toHaveBeenCalled()
  })
})
