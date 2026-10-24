import { beforeEach, describe, expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({ pending: vi.fn(), owners: vi.fn(), touch: vi.fn(), remove: vi.fn(), reconcile: vi.fn(), warn: vi.fn() }))
vi.mock("@alook/shared", () => ({ createLogger: () => ({ warn: mocks.warn }), queries: {
  accountDeletion: { listPendingAccountDeletions: mocks.pending },
  billing: { listBillingOwners: mocks.owners, recordBillingRecoveryAttempt: mocks.touch },
} }))
vi.mock("./db", () => ({ getPrimaryDb: () => ({}) }))
vi.mock("./account-deletion/execution", () => ({ executeAccountDeletion: mocks.remove }))
vi.mock("./billing/client", () => ({ billingClient: () => ({}) }))
vi.mock("./billing/reconcile", () => ({ reconcileBilling: mocks.reconcile }))
import { maintainAccounts } from "./account-maintenance"

describe("account recovery pass", () => {
  beforeEach(() => { vi.resetAllMocks(); mocks.pending.mockResolvedValue([]); mocks.owners.mockResolvedValue([]) })
  it("reuses deletion and authoritative reconciliation and advances past a failed owner", async () => {
    mocks.pending.mockResolvedValue([{ id: "deleting" }])
    mocks.owners.mockResolvedValue([{ userId: "failed" }, { userId: "paid" }])
    mocks.reconcile.mockRejectedValueOnce(new Error("Stripe outage")).mockResolvedValueOnce("applied")
    await maintainAccounts({} as Env, { waitUntil: vi.fn() })
    expect(mocks.remove).toHaveBeenCalledOnce()
    expect(mocks.touch.mock.calls.map(call => call[1])).toEqual(["failed", "paid"])
    expect(mocks.reconcile).toHaveBeenCalledTimes(2)
    expect(mocks.warn).toHaveBeenCalledWith("billing_recovery_failed", { userId: "failed" })
  })
  it("stops starting work after the time budget and still runs the other recovery pass", async () => {
    vi.useFakeTimers()
    try {
      mocks.pending.mockResolvedValue([{ id: "slow" }, { id: "later" }])
      mocks.remove.mockImplementation(async () => { vi.advanceTimersByTime(4 * 60_000); return { kind: "pending" } })
      mocks.owners.mockResolvedValue([{ userId: "paid" }])
      await maintainAccounts({} as Env, { waitUntil: vi.fn() })
      expect(mocks.remove).toHaveBeenCalledOnce()
      expect(mocks.reconcile).toHaveBeenCalledOnce()
    } finally { vi.useRealTimers() }
  })
})
