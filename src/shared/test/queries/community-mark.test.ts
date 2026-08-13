import { describe, expect, it, vi } from "vitest"
import * as marks from "../../src/db/queries/community/mark"

function countDb(responses: Array<Array<{ count: number }>>) {
  let call = 0
  const select = vi.fn(() => {
    const rows = responses[call++] ?? []
    const chain: any = {}
    chain.from = vi.fn(() => chain)
    chain.where = vi.fn(() => Promise.resolve(rows))
    return chain
  })
  return { select } as any
}

describe("countMarksForUser", () => {
  it("returns zero without querying for an empty visibility scope", async () => {
    const db = countDb([])
    await expect(marks.countMarksForUser(db, "u1", {
      visibleChannelIds: [],
    })).resolves.toBe(0)
    expect(db.select).not.toHaveBeenCalled()
  })

  it("sums every visibility chunk beyond D1's 100-parameter boundary", async () => {
    const db = countDb([[{ count: 100 }], [{ count: 1 }]])
    const visibleChannelIds = Array.from({ length: 101 }, (_, index) => `c${index}`)
    await expect(marks.countMarksForUser(db, "u1", {
      visibleChannelIds,
    })).resolves.toBe(101)
    expect(db.select).toHaveBeenCalledTimes(2)
  })
})
