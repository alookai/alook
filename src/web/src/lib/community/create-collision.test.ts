import { describe, it, expect, vi } from "vitest"
import { createWithCollisionPolicy } from "./create-collision"

// A unique-constraint error shaped like the ones isUniqueConstraintError detects.
// isUniqueConstraintError checks the message for the SQLite unique-violation
// signature, so mirror that here.
function uniqueErr(): Error {
  return new Error("D1_ERROR: UNIQUE constraint failed: community_channel.name")
}

describe("createWithCollisionPolicy — trait-keyed create collision dispatch (B4)", () => {
  describe("get-or-create (thread/dm-anchor): fetch the winner, never make a second", () => {
    it("returns the created value on a clean attempt", async () => {
      const attempt = vi.fn().mockResolvedValue({ id: "t1" })
      const res = await createWithCollisionPolicy("get-or-create", { attempt, refetchWinner: vi.fn() })
      expect(res).toEqual({ ok: true, value: { id: "t1" } })
    })

    it("on a unique collision re-selects the winner — NOT a second unit", async () => {
      const attempt = vi.fn().mockRejectedValue(uniqueErr())
      const refetchWinner = vi.fn().mockResolvedValue({ id: "winner" })
      const res = await createWithCollisionPolicy("get-or-create", { attempt, refetchWinner })
      expect(res).toEqual({ ok: true, value: { id: "winner" } })
      expect(refetchWinner).toHaveBeenCalledTimes(1)
      expect(attempt).toHaveBeenCalledTimes(1) // no re-attempt/bump
    })

    it("re-throws if the winner can't be refetched (collision but no winner found)", async () => {
      const attempt = vi.fn().mockRejectedValue(uniqueErr())
      const refetchWinner = vi.fn().mockResolvedValue(null)
      await expect(createWithCollisionPolicy("get-or-create", { attempt, refetchWinner })).rejects.toThrow()
    })
  })

  describe("reject-on-collision (top-level text/forum): refuse with the caller's error", () => {
    it("returns the created value on a clean attempt", async () => {
      const attempt = vi.fn().mockResolvedValue({ id: "c1" })
      const res = await createWithCollisionPolicy("reject-on-collision", { attempt })
      expect(res).toEqual({ ok: true, value: { id: "c1" } })
    })

    it("on a unique collision returns the onReject error (409), never bumps or refetches", async () => {
      const attempt = vi.fn().mockRejectedValue(uniqueErr())
      const refetchWinner = vi.fn()
      const res = await createWithCollisionPolicy("reject-on-collision", {
        attempt,
        refetchWinner,
        onReject: () => ({ status: 409, error: "a channel with this name already exists" }),
      })
      expect(res).toEqual({ ok: false, status: 409, error: "a channel with this name already exists" })
      expect(attempt).toHaveBeenCalledTimes(1) // no re-bump
      expect(refetchWinner).not.toHaveBeenCalled() // no fetch-winner
    })
  })

  // Aigneis's "contracts don't cross" — each value's collision end-state is
  // strictly its own: get-or-create fetches (1 shared), reject-on-collision
  // 409s (0 new). The per-value tests above already assert neither leaks the
  // other's behavior (reject ignores both bump and refetch; get-or-create
  // doesn't re-attempt).
})
