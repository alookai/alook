import React from "react"
import { focusManager, QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@/test/react-dom-harness"
import { communityKeys } from "@/lib/query-keys"
import { readBillingReturn, useBilling } from "./use-billing"

const mocks = vi.hoisted(() => ({ api: vi.fn() }))
vi.mock("@/lib/api/client", () => ({ apiFetch: mocks.api }))
const free = { plan: { id: "free", displayName: "Free" }, isFounder: false, offers: [], subscription: null }

function setup(returnFrom: Parameters<typeof useBilling>[0] = null, enabled = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  const invalidate = vi.spyOn(client, "invalidateQueries")
  const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
  return { ...renderHook(() => useBilling(returnFrom, enabled), { wrapper }), client, invalidate }
}

describe("billing queries and redirects", () => {
  beforeEach(() => { mocks.api.mockReset(); mocks.api.mockResolvedValue(free) })
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

  it("does not load billing for the ordinary My Bots view", () => {
    const view = setup(null, false)
    expect(mocks.api).not.toHaveBeenCalled()
    view.unmount()
  })

  it("rejects arbitrary return markers and never grants from a checkout return", async () => {
    expect(readBillingReturn("success")).toBeNull()
    expect(readBillingReturn("checkout")).toBe("checkout")
    const view = setup("checkout")
    await waitFor(() => expect(view.result.current.data?.plan.id).toBe("free"))
    expect(view.client.getQueryData(communityKeys.bots())).toBeUndefined()
    expect(view.invalidate).toHaveBeenCalledWith({ queryKey: communityKeys.bots() })
    view.unmount()
  })

  it("bounds automatic return polling and still allows manual refresh", async () => {
    vi.useFakeTimers()
    const view = setup("portal")
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(view.result.current.polling).toBe(true)
    await act(async () => { await vi.advanceTimersByTimeAsync(31_000) })
    expect(view.result.current.polling).toBe(false)
    const calls = mocks.api.mock.calls.length
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(mocks.api).toHaveBeenCalledTimes(calls)
    await act(async () => { view.result.current.refresh(); await vi.advanceTimersByTimeAsync(1) })
    expect(mocks.api.mock.calls.length).toBeGreaterThan(calls)
    view.unmount()
  })

  it("resumes only the remaining return window without replaying invalidations", async () => {
    vi.useFakeTimers()
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const invalidate = vi.spyOn(client, "invalidateQueries")
    const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
    const view = renderHook(({ enabled }) => useBilling("portal", enabled), { wrapper, initialProps: { enabled: true } })
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(view.result.current.polling).toBe(true)
    view.rerender({ enabled: false })
    expect(view.result.current.polling).toBe(false)
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000) })
    const calls = mocks.api.mock.calls.length
    view.rerender({ enabled: true })
    expect(view.result.current.polling).toBe(true)
    await act(async () => { await vi.advanceTimersByTimeAsync(4_000) })
    expect(mocks.api.mock.calls.length).toBeGreaterThan(calls)
    await act(async () => { await vi.advanceTimersByTimeAsync(6_001) })
    expect(view.result.current.polling).toBe(false)
    view.rerender({ enabled: false })
    view.rerender({ enabled: true })
    expect(view.result.current.polling).toBe(false)
    expect(invalidate.mock.calls.filter(([args]) => JSON.stringify(args?.queryKey) === JSON.stringify(communityKeys.bots()))).toHaveLength(1)
    view.unmount()
  })

  it("keeps return polling alive through StrictMode effect replay", async () => {
    vi.useFakeTimers()
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const wrapper = ({ children }: { children: React.ReactNode }) => <React.StrictMode><QueryClientProvider client={client}>{children}</QueryClientProvider></React.StrictMode>
    const view = renderHook(() => useBilling("portal", true), { wrapper })
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(view.result.current.polling).toBe(true)
    await act(async () => { await vi.advanceTimersByTimeAsync(30_001) })
    expect(view.result.current.polling).toBe(false)
    view.unmount()
  })

  it("reuses fresh billing data on focus but refreshes stale data", async () => {
    vi.useFakeTimers()
    const view = setup()
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    const calls = mocks.api.mock.calls.length
    await act(async () => { focusManager.setFocused(false); focusManager.setFocused(true); await vi.advanceTimersByTimeAsync(1) })
    expect(mocks.api).toHaveBeenCalledTimes(calls)
    await act(async () => { await vi.advanceTimersByTimeAsync(30_001); focusManager.setFocused(false); focusManager.setFocused(true); await vi.advanceTimersByTimeAsync(1) })
    expect(mocks.api).toHaveBeenCalledTimes(calls + 1)
    view.unmount()
    focusManager.setFocused(undefined)
  })

  it("does not poll an abandoned checkout", async () => {
    const view = setup("cancel")
    await waitFor(() => expect(view.result.current.data).toEqual(free))
    expect(view.result.current.polling).toBe(false)
    view.unmount()
  })

  it("does not reload bots for unchanged billing polls and stops when paid access is confirmed", async () => {
    vi.useFakeTimers()
    const view = setup("checkout")
    await act(async () => { await vi.advanceTimersByTimeAsync(6_001) })
    const botRefreshes = () => view.invalidate.mock.calls.filter(([args]) => JSON.stringify(args?.queryKey) === JSON.stringify(communityKeys.bots())).length
    expect(botRefreshes()).toBe(1)
    const paid = { ...free, plan: { id: "studio", displayName: "Studio" }, subscription: {
      plan: { id: "studio", displayName: "Studio" }, status: "active", currentPeriodEnd: null, cancelAt: null, scheduledChange: null,
    } }
    mocks.api.mockResolvedValue(paid)
    await act(async () => { await vi.advanceTimersByTimeAsync(2_001) })
    expect(view.result.current.data?.plan.id).toBe("studio")
    expect(botRefreshes()).toBe(2)
    expect(view.result.current.polling).toBe(false)
    const calls = mocks.api.mock.calls.length
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(mocks.api).toHaveBeenCalledTimes(calls)
    view.unmount()
  })

  it("blocks unacknowledged Founder checkout and unrelated mutations", async () => {
    mocks.api.mockResolvedValue({ ...free, isFounder: true })
    const view = setup()
    await waitFor(() => expect(view.result.current.data?.isFounder).toBe(true))
    await act(async () => { await view.result.current.checkout("price_any"); await view.result.current.portal(); await view.result.current.cancelChange() })
    expect(mocks.api.mock.calls.every(([url]) => url === "/api/community/billing")).toBe(true)
    view.unmount()
  })

  it("sends Founder acknowledgment only on explicit confirmed checkout and serializes it", async () => {
    const founder = { ...free, isFounder: true }
    mocks.api.mockResolvedValue(founder)
    const view = setup()
    await waitFor(() => expect(view.result.current.data?.isFounder).toBe(true))
    let reject!: (error: Error) => void
    mocks.api.mockImplementation((url: string) => url.endsWith("/checkout")
      ? new Promise((_resolve, rejectPromise) => { reject = rejectPromise }) : Promise.resolve(founder))
    let request!: Promise<void>
    await act(async () => {
      request = view.result.current.checkout("price_house", true)
      void view.result.current.checkout("price_studio", true)
    })
    expect(mocks.api.mock.calls.filter(([url]) => url.endsWith("/checkout"))).toHaveLength(1)
    expect(mocks.api).toHaveBeenCalledWith("/api/community/billing/checkout", { method: "POST", body: '{"priceId":"price_house","founderAcknowledged":true}' })
    await act(async () => { reject(new Error("cancel")); await request })
    expect(view.result.current.data?.isFounder).toBe(true)
    view.unmount()
  })

  it("serializes double clicks and allows retry after an unknown outcome", async () => {
    const view = setup()
    await waitFor(() => expect(view.result.current.data).toEqual(free))
    let reject!: (error: Error) => void
    mocks.api.mockImplementation((url: string) => url.endsWith("/checkout")
      ? new Promise((_resolve, rejectPromise) => { reject = rejectPromise })
      : Promise.resolve(free))
    let request!: Promise<void>
    await act(async () => {
      request = view.result.current.checkout("price_one")
      void view.result.current.checkout("price_two")
    })
    expect(mocks.api.mock.calls.filter(([url]) => url.endsWith("/checkout"))).toHaveLength(1)
    expect(mocks.api).toHaveBeenCalledWith("/api/community/billing/checkout", { method: "POST", body: '{"priceId":"price_one"}' })
    await act(async () => { reject(new Error("timeout")); await request })
    expect(view.result.current.isBusy).toBe(false)
    expect(view.result.current.actionError).toContain("resume your purchase")
    mocks.api.mockImplementation((url: string) => url.endsWith("/checkout") ? Promise.reject(new Error("timeout")) : Promise.resolve(free))
    await act(async () => { await view.result.current.checkout("price_one") })
    expect(mocks.api.mock.calls.filter(([url]) => url.endsWith("/checkout"))).toHaveLength(2)
    view.unmount()
  })

  it("rejects an unsafe redirect and exposes a recoverable management error", async () => {
    const view = setup()
    await waitFor(() => expect(view.result.current.data).toEqual(free))
    mocks.api.mockImplementation((url: string) => Promise.resolve(url.endsWith("/portal") ? { url: "javascript:alert(1)" } : free))
    await act(async () => { await view.result.current.portal() })
    expect(view.result.current.actionError).toContain("billing management")
    expect(view.result.current.isBusy).toBe(false)
    view.unmount()
  })

  it("navigates to the hosted confirmation for a selected price and recovers after browser Back", async () => {
    const view = setup()
    await waitFor(() => expect(view.result.current.data).toEqual(free))
    const originalWindow = window
    const assign = vi.fn()
    const mockWindow = new Proxy(originalWindow, {
      get: (target, key) => key === "location" ? { assign } : Reflect.get(target, key, target),
    })
    mocks.api.mockImplementation((url: string) => Promise.resolve(url.endsWith("/portal") ? { url: "https://billing.stripe.com/p/session" } : free))
    vi.stubGlobal("window", mockWindow)
    await act(async () => { await view.result.current.portal("price_target") })
    expect(mocks.api).toHaveBeenCalledWith("/api/community/billing/portal", { method: "POST", body: '{"priceId":"price_target"}' })
    expect(assign).toHaveBeenCalledWith("https://billing.stripe.com/p/session")
    expect(view.result.current.isBusy).toBe(true)
    vi.stubGlobal("window", originalWindow)
    const restored = new Event("pageshow")
    Object.defineProperty(restored, "persisted", { value: true })
    await act(async () => { originalWindow.dispatchEvent(restored) })
    expect(view.result.current.isBusy).toBe(false)
    expect(view.invalidate).toHaveBeenCalledWith({ queryKey: communityKeys.billing() })
    view.unmount()
  })

  it.each([false, true])("uses the cancel-change response without assuming the old plan survives (crossed period: %s)", async (crossedPeriod) => {
    const house = { id: "house", displayName: "House" }
    const scheduled = { ...free, plan: house, subscription: {
      plan: house, status: "active", currentPeriodEnd: "2026-10-10T00:00:00Z", cancelAt: "2026-10-08T00:00:00Z",
      scheduledChange: { plan: free.plan, effectiveAt: "2026-10-10T00:00:00Z" },
    } }
    mocks.api.mockResolvedValue(scheduled)
    const view = setup()
    await waitFor(() => expect(view.result.current.data?.subscription?.scheduledChange).toBeTruthy())
    const response = { ...scheduled, plan: crossedPeriod ? free.plan : house, subscription: { ...scheduled.subscription, scheduledChange: null } }
    let finish!: (value: unknown) => void
    mocks.api.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    let request!: Promise<void>
    await act(async () => {
      request = view.result.current.cancelChange()
      void view.result.current.cancelChange()
      void view.result.current.portal()
    })
    expect(mocks.api.mock.calls.filter(([url]) => url.endsWith("/cancel-change"))).toHaveLength(1)
    expect(mocks.api).toHaveBeenLastCalledWith("/api/community/billing/cancel-change", { method: "POST" })
    await waitFor(() => expect(view.result.current.isCancelingChange).toBe(true))
    await act(async () => { finish(response); await request })
    await waitFor(() => expect(view.result.current.data).toEqual(response))
    expect(view.result.current.isBusy).toBe(false)
    expect(view.invalidate.mock.calls.filter(([args]) => JSON.stringify(args?.queryKey) === JSON.stringify(communityKeys.bots()))).toHaveLength(crossedPeriod ? 1 : 0)
    view.unmount()
  })

  it("keeps a failed cancellation recoverable without optimistic plan changes", async () => {
    const scheduled = { ...free, subscription: { plan: free.plan, status: "active", currentPeriodEnd: null, cancelAt: null, scheduledChange: { plan: free.plan, effectiveAt: "2026-10-10T00:00:00Z" } } }
    mocks.api.mockResolvedValue(scheduled)
    const view = setup()
    await waitFor(() => expect(view.result.current.data).toEqual(scheduled))
    mocks.api.mockImplementation((url: string) => url.endsWith("/cancel-change") ? Promise.reject(new Error("timeout")) : Promise.resolve(scheduled))
    await act(async () => { await view.result.current.cancelChange() })
    expect(view.result.current.actionError).toContain("scheduled plan change")
    expect(view.result.current.data).toEqual(scheduled)
    expect(view.result.current.isBusy).toBe(false)
    await act(async () => { await view.result.current.cancelChange() })
    expect(mocks.api.mock.calls.filter(([url]) => url.endsWith("/cancel-change"))).toHaveLength(2)
    view.unmount()
  })

  it("rejects a malformed summary instead of showing fabricated plan state", async () => {
    mocks.api.mockResolvedValue({ plan: free.plan })
    const view = setup()
    await waitFor(() => expect(view.result.current.isError).toBe(true))
    expect(view.result.current.data).toBeUndefined()
    view.unmount()
  })
})
