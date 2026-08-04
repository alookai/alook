import { describe, it, expect, vi } from "vitest"
import { createWithCollisionPolicy } from "./create-collision"

// A unique-constraint error shaped like the ones isUniqueConstraintError detects.
// isUniqueConstraintError checks the message for the SQLite unique-violation
// signature, so mirror that here.
function uniqueErr(): Error {
  return new Error("D1_ERROR: UNIQUE constraint failed: community_channel.name")
}

describe("createWithCollisionPolicy — trait-keyed create collision dispatch (B4)", () => {
  describe("pure-create (forum_post): bump-and-retry, never merge", () => {
    it("returns the created value on a clean first attempt", async () => {
      const attempt = vi.fn().mockResolvedValue({ id: "p1" })
      const res = await createWithCollisionPolicy("pure-create", { attempt })
      expect(res).toEqual({ ok: true, value: { id: "p1" } })
      expect(attempt).toHaveBeenCalledTimes(1)
    })

    it("re-runs attempt (re-bump) on a unique collision, then succeeds", async () => {
      const attempt = vi
        .fn()
        .mockRejectedValueOnce(uniqueErr())
        .mockRejectedValueOnce(uniqueErr())
        .mockResolvedValueOnce({ id: "p3" })
      const res = await createWithCollisionPolicy("pure-create", { attempt })
      expect(res).toEqual({ ok: true, value: { id: "p3" } })
      expect(attempt).toHaveBeenCalledTimes(3)
    })

    it("NEVER re-selects a winner — pure-create ignores refetchWinner even if supplied", async () => {
      const refetchWinner = vi.fn().mockResolvedValue({ id: "someone-elses" })
      const attempt = vi.fn().mockRejectedValueOnce(uniqueErr()).mockResolvedValueOnce({ id: "mine" })
      const res = await createWithCollisionPolicy("pure-create", { attempt, refetchWinner })
      // The 2nd attempt (re-bump) wins — the caller's OWN row, not the winner.
      expect(res).toEqual({ ok: true, value: { id: "mine" } })
      expect(refetchWinner).not.toHaveBeenCalled()
    })

    it("gives up with 409 after maxAttempts collisions (index-missing / pathological)", async () => {
      const attempt = vi.fn().mockRejectedValue(uniqueErr())
      const res = await createWithCollisionPolicy("pure-create", { attempt, maxAttempts: 3 })
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.status).toBe(409)
      expect(attempt).toHaveBeenCalledTimes(3)
    })

    it("re-throws a non-unique error (real failure, not a collision)", async () => {
      const attempt = vi.fn().mockRejectedValue(new Error("boom"))
      await expect(createWithCollisionPolicy("pure-create", { attempt })).rejects.toThrow("boom")
    })
  })

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

  // Aigneis's "three contracts don't cross" — each value's collision end-state is
  // strictly its own: pure-create bumps (N distinct), get-or-create fetches (1
  // shared), reject-on-collision 409s (0 new). The per-value tests above already
  // assert none leaks another's behavior (pure-create ignores refetchWinner;
  // reject ignores both bump and refetch; get-or-create doesn't re-attempt).
})
