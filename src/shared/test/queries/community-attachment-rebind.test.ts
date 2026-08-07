import { describe, expect, it, vi } from "vitest"
import { rebindPendingAttachmentsToChild } from "../../src/db/queries/community/attachment"

function createDb(reboundIds: string[]) {
  const countChain: any = {}
  countChain.from = vi.fn(() => countChain)
  countChain.where = vi.fn(() => countChain)
  const updateChain: any = {}
  updateChain.set = vi.fn(() => updateChain)
  updateChain.where = vi.fn(() => updateChain)
  updateChain.returning = vi.fn(async () => reboundIds.map((id) => ({ id })))
  return {
    select: vi.fn(() => countChain),
    update: vi.fn(() => updateChain),
    countChain,
    updateChain,
  }
}

describe("rebindPendingAttachmentsToChild", () => {
  it("moves an eligible pending attachment to the direct child target", async () => {
    const db = createDb(["attachment_1"])

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
    const db = createDb(["attachment_1"])

    const result = await rebindPendingAttachmentsToChild(db as any, {
      ids: ["attachment_1"],
      uploaderId: "user_1",
      parentTargetId: "forum_1",
      childTargetId: "thread_1",
    })

    expect(result).toBe(true)
  })

  it("rejects the whole set when any requested attachment is outside the scoped pending rows", async () => {
    const db = createDb([])

    const result = await rebindPendingAttachmentsToChild(db as any, {
      ids: ["attachment_1", "sibling_or_foreign_attachment"],
      uploaderId: "user_1",
      parentTargetId: "forum_1",
      childTargetId: "thread_1",
    })

    expect(result).toBe(false)
    expect(db.update).toHaveBeenCalledTimes(1)
    expect(db.select).toHaveBeenCalledTimes(1)
  })

  it("rejects a partial-overlap race from the guarded statement", async () => {
    const db = createDb(["attachment_1"])

    const result = await rebindPendingAttachmentsToChild(db as any, {
      ids: ["attachment_1", "attachment_2"],
      uploaderId: "user_1",
      parentTargetId: "forum_1",
      childTargetId: "thread_1",
    })

    expect(result).toBe(false)
    expect(db.updateChain.returning).toHaveBeenCalledTimes(1)
  })
})
