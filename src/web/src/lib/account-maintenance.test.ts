import { beforeEach, describe, expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({ pending: vi.fn(), page: vi.fn(), touch: vi.fn(), remove: vi.fn(), reconcile: vi.fn(), warn: vi.fn(), get: vi.fn(), put: vi.fn() }))
vi.mock("@alook/shared", () => ({ createLogger: () => ({ warn: mocks.warn }), queries: {
  accountDeletion: { listPendingAccountDeletions: mocks.pending },
  billing: { listBillingRecoveryPage: mocks.page, recordBillingRecoveryAttempt: mocks.touch },
} }))
vi.mock("./db", () => ({ getPrimaryDb: () => ({}) }))
vi.mock("./account-deletion/execution", () => ({ executeAccountDeletion: mocks.remove }))
vi.mock("./billing/client", () => ({ billingClient: () => ({}) }))
vi.mock("./billing/reconcile", () => ({ reconcileBilling: mocks.reconcile }))
import { maintainAccounts } from "./account-maintenance"

const row = (userId: string, deletedAt: string | null = null, updatedAt = "2000-01-01") => ({ userId, deletedAt, updatedAt })
const env = () => ({ CACHE_KV: { get: mocks.get, put: mocks.put } }) as unknown as Env
const run = () => maintainAccounts(env(), { waitUntil: vi.fn() })

describe("account recovery pass", () => {
  beforeEach(() => { vi.resetAllMocks(); mocks.pending.mockResolvedValue([]); mocks.page.mockResolvedValue([]); mocks.get.mockResolvedValue(null); mocks.put.mockResolvedValue(undefined) })
  it("reuses deletion and authoritative reconciliation and advances past a failed owner", async () => {
    mocks.pending.mockResolvedValue([{ id: "deleting" }])
    mocks.page.mockResolvedValueOnce([row("failed"), row("paid")])
    mocks.reconcile.mockRejectedValueOnce(new Error("Stripe outage")).mockResolvedValueOnce("applied")
    await run()
    expect(mocks.remove).toHaveBeenCalledOnce()
    expect(mocks.touch.mock.calls.map(call => call[1])).toEqual(["failed", "paid"])
    expect(mocks.reconcile).toHaveBeenCalledTimes(2)
    expect(mocks.warn).toHaveBeenCalledWith("billing_recovery_failed", { userId: "failed" })
    expect(JSON.parse(mocks.put.mock.calls[0][1])).toEqual({ userId: "paid", updatedAt: "2000-01-01" })
  })
  it("stops starting deletion work after its budget and still runs billing recovery", async () => {
    vi.useFakeTimers()
    try {
      mocks.pending.mockResolvedValue([{ id: "slow" }, { id: "later" }])
      mocks.remove.mockImplementation(async () => { vi.advanceTimersByTime(4 * 60_000); return { kind: "pending" } })
      mocks.page.mockResolvedValueOnce([row("paid")])
      await run()
      expect(mocks.remove).toHaveBeenCalledOnce()
      expect(mocks.reconcile).toHaveBeenCalledOnce()
    } finally { vi.useRealTimers() }
  })
  it("pages past deleted owners, resumes the saved cursor and never reconciles one owner twice", async () => {
    mocks.get.mockResolvedValue({ userId: "previous", updatedAt: "1999" })
    mocks.page.mockResolvedValueOnce(Array.from({ length: 25 }, (_, i) => row(`deleted${i}`, "2026-01-01")))
      .mockResolvedValueOnce([row("paid")]).mockResolvedValueOnce([row("paid", null, "2026-01-02")])
    await run()
    expect(mocks.page.mock.calls[0][1]).toEqual({ userId: "previous", updatedAt: "1999" })
    expect(mocks.page.mock.calls[1][1]).toEqual({ userId: "deleted24", updatedAt: "2000-01-01" })
    expect(mocks.touch.mock.calls.map(call => call[1])).toEqual(["paid"])
    expect(mocks.reconcile).toHaveBeenCalledOnce()
    expect(JSON.parse(mocks.put.mock.calls[0][1])).toEqual({ userId: "paid", updatedAt: "2026-01-02" })
  })
  it("caps the pass at 25 distinct owners and saves only the last visited candidate", async () => {
    mocks.page.mockResolvedValueOnce(Array.from({ length: 25 }, (_, i) => row(`paid${i}`)))
    await run()
    expect(mocks.touch).toHaveBeenCalledTimes(25)
    expect(mocks.page).toHaveBeenCalledOnce()
    expect(JSON.parse(mocks.put.mock.calls[0][1])).toEqual({ userId: "paid24", updatedAt: "2000-01-01" })
  })
  it("does not advance past unstarted work when the billing time budget expires", async () => {
    vi.useFakeTimers()
    try {
      mocks.page.mockResolvedValueOnce([row("slow"), row("later")])
      mocks.reconcile.mockImplementation(async () => { vi.advanceTimersByTime(4 * 60_000) })
      await run()
      expect(mocks.touch.mock.calls.map(call => call[1])).toEqual(["slow"])
      expect(JSON.parse(mocks.put.mock.calls[0][1])).toEqual({ userId: "slow", updatedAt: "2000-01-01" })
    } finally { vi.useRealTimers() }
  })
  it("restarts once from the beginning when a saved cursor is beyond the current data", async () => {
    mocks.get.mockResolvedValue({ userId: "old", updatedAt: "2099" })
    mocks.page.mockResolvedValueOnce([]).mockResolvedValueOnce([row("paid")])
    await run()
    expect(mocks.page.mock.calls.slice(0, 2).map(call => call[1])).toEqual([{ userId: "old", updatedAt: "2099" }, undefined])
    expect(mocks.reconcile).toHaveBeenCalledOnce()
  })
  it("keeps the old saved cursor if recording a DB attempt fails", async () => {
    mocks.page.mockResolvedValueOnce([row("paid")])
    mocks.touch.mockRejectedValueOnce(new Error("database unavailable"))
    await run()
    expect(mocks.reconcile).not.toHaveBeenCalled()
    expect(mocks.put).not.toHaveBeenCalled()
    expect(mocks.warn).toHaveBeenCalledWith("billing_recovery_failed", { userId: "paid" })
  })
  it("recovers without a cached cursor and keeps successful work when KV writes fail", async () => {
    mocks.get.mockRejectedValue(new Error("KV unavailable"))
    mocks.put.mockRejectedValue(new Error("KV unavailable"))
    mocks.page.mockResolvedValueOnce([row("paid")])
    await run()
    expect(mocks.reconcile).toHaveBeenCalledOnce()
    expect(mocks.warn).toHaveBeenCalledWith("billing_recovery_cursor_read_failed")
    expect(mocks.warn).toHaveBeenCalledWith("billing_recovery_cursor_write_failed")
  })
})
