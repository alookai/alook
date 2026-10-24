import { beforeEach, describe, expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({ billing: vi.fn(), current: vi.fn(), expire: vi.fn(), cancel: vi.fn(), retrieve: vi.fn(), list: vi.fn() }))
vi.mock("@alook/shared", () => ({ queries: { billing: { getBilling: mocks.billing } } }))
vi.mock("./reconcile", () => ({ currentSubscription: mocks.current, reconcileBilling: vi.fn() }))
vi.mock("./client", async importOriginal => ({ ...await importOriginal<typeof import("./client")>(), billingClient: () => ({
  checkout: { sessions: { retrieve: mocks.retrieve, list: mocks.list, expire: mocks.expire } },
  subscriptions: { cancel: mocks.cancel },
}) }))
import { closeAccountBilling } from "./service"
const env = { STRIPE_SECRET_KEY: "sk_test_fixture" } as Env
const attempt = { id: "attempt", sessionId: "checkout", startedAt: Math.floor(Date.now() / 1000) }

describe("account billing shutdown", () => {
  beforeEach(() => { vi.resetAllMocks(); mocks.list.mockReturnValue({ async *[Symbol.asyncIterator]() {} }) })
  it("expires a payable checkout before cancelling the current subscription", async () => {
    mocks.billing.mockResolvedValue({ userId: "owner", customerId: "customer", checkoutAttempt: attempt })
    mocks.retrieve.mockResolvedValue({ id: "checkout", customer: "customer", metadata: { alook_attempt_id: "attempt" }, livemode: false, status: "open" })
    mocks.current.mockResolvedValue({ id: "subscription", status: "active" })
    await closeAccountBilling({} as never, env, "owner")
    expect(mocks.expire).toHaveBeenCalledWith("checkout")
    expect(mocks.cancel).toHaveBeenCalledWith("subscription")
    expect(mocks.expire).toHaveBeenCalledBefore(mocks.cancel)
  })
  it("retains an ambiguous in-flight checkout until its fixed payment window ends", async () => {
    mocks.billing.mockResolvedValue({ userId: "owner", customerId: "customer", checkoutAttempt: { ...attempt, sessionId: null } })
    await expect(closeAccountBilling({} as never, env, "owner")).rejects.toMatchObject({ code: "BILLING_CHECKOUT_UNRESOLVED" })
    expect(mocks.current).not.toHaveBeenCalled()
    mocks.billing.mockResolvedValue({ userId: "owner", customerId: "customer", checkoutAttempt: { ...attempt, sessionId: null, startedAt: 1 } })
    await expect(closeAccountBilling({} as never, env, "owner")).resolves.toBeUndefined()
    expect(mocks.current).toHaveBeenCalledOnce()
  })
  it("propagates a failed cancellation so the billing mapping cannot be purged", async () => {
    mocks.billing.mockResolvedValue({ userId: "owner", customerId: "customer", checkoutAttempt: null })
    mocks.current.mockResolvedValue({ id: "subscription", status: "active" })
    mocks.cancel.mockRejectedValue(new Error("unknown Stripe outcome"))
    await expect(closeAccountBilling({} as never, env, "owner")).rejects.toThrow("unknown Stripe outcome")
  })
  it("does not require Stripe for an account with no billing history", async () => {
    mocks.billing.mockResolvedValue(null)
    await expect(closeAccountBilling({} as never, {} as Env, "owner")).resolves.toBeUndefined()
    expect(mocks.current).not.toHaveBeenCalled()
  })
})
