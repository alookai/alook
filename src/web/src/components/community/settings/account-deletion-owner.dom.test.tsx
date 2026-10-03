import { useLayoutEffect } from "react"
import "fake-indexeddb/auto"
import React from "react"
import { useIsRestoring, useQueryClient } from "@tanstack/react-query"
import { get, set } from "idb-keyval"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen, waitFor } from "@/test/react-dom-harness"
import { QueryProvider } from "@/app/c/QueryProvider"
import { AccountDeletionFlow } from "./account-deletion-flow"
import { tid } from "@/lib/community/testids"
import { getCommunityDbRegistry, type CommunityDbRegistry } from "@/lib/community-db/collections"
import { clearAllPersistedCaches, createIdbPersister } from "@/lib/query-persister"
const sdk = vi.hoisted(() => ({ id: "A" }))
vi.mock("@/lib/auth-client", () => { const sessionSDK = { useSession: () => ({ data: { user: { id: sdk.id } }, isPending: false, error: null }) }; return { ...sessionSDK, currentSessionViewer: () => { const value = sessionSDK.useSession(); return !value || value.isPending || value.error ? undefined : value.data?.user.id ?? null } } })
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }) }))
vi.mock("@tanstack/react-query-devtools", () => ({ ReactQueryDevtools: () => null }))
let registry: CommunityDbRegistry, replace: ReturnType<typeof vi.fn>, reload: ReturnType<typeof vi.fn>, onDeleted: ReturnType<typeof vi.fn<() => Promise<void>>>
let held: Array<{ path: string; signal: AbortSignal; resolve: (response: Response) => void }>
let restoring: boolean
function Probe({ deletion }: { deletion: boolean }) { const currentRestoring = useIsRestoring(); const current = getCommunityDbRegistry(useQueryClient())!; useLayoutEffect(() => { registry = current; restoring = currentRestoring }); return deletion ? <AccountDeletionFlow email="A@example.test" onCancel={vi.fn()} onDeleted={onDeleted} /> : <p>Account B</p> }
function App({ id = "A", deletion = true }: { id?: string; deletion?: boolean }) { return <QueryProvider userId={id}><Probe deletion={deletion} /></QueryProvider> }
beforeEach(async () => {
  restoring = true
  await act(async () => { await clearAllPersistedCaches(); }) ; sdk.id = "A"; held = []; onDeleted = vi.fn(async () => {}); replace = vi.fn(); reload = vi.fn(); vi.stubGlobal("location", { replace }); const real = window
  vi.stubGlobal("window", new Proxy(real, { get: (target, key) => key === "location" ? { reload, replace, assign: vi.fn() } : Reflect.get(target, key, target) }))
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} }); document.elementFromPoint = vi.fn(() => null)
  vi.stubGlobal("fetch", vi.fn((path: string, options: RequestInit) => new Promise<Response>((resolve) => held.push({ path, signal: options.signal as AbortSignal, resolve }))))
  return async () => {
    await act(async () => { if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0); else await new Promise((resolve) => setTimeout(resolve, 0)) })
    vi.useRealTimers()
    vi.unstubAllGlobals()
  }
})
async function deleteRequest() {
  await waitFor(() => expect(restoring).toBe(false))
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
  fireEvent.click(screen.getByTestId(tid.accountDeletionSendCode))
  await act(async () => { await vi.waitFor(() => expect(held).toHaveLength(1)) })
  await act(async () => held[0].resolve(Response.json({ ok: true, resend_after: 60 })))
  const input = screen.getByTestId(tid.accountDeletionOtp)
  await act(async () => { await vi.advanceTimersByTimeAsync(50) })
  await act(async () => { fireEvent.change(input, { target: { value: "123456" } }) })
  await act(async () => { await vi.advanceTimersByTimeAsync(50) })
  await act(async () => { fireEvent.click(screen.getByTestId(tid.accountDeletionSubmit)) })
  await act(async () => { await vi.waitFor(() => expect(held).toHaveLength(2)) }); return held[1]
}
describe("actual account deletion original root settlement", () => {
  it("old successful200 clears original A facts/disk, including late old payload, without changing B or navigating", async () => {
    const view = render(<App />); const request = await deleteRequest(); const original = registry
    sdk.id = "B"; await act(async () => { view.rerender(<App id="B" deletion={false} />) }); await act(async () => { await vi.advanceTimersByTimeAsync(0) }); vi.useRealTimers()
    await waitFor(() => expect(registry.accountId).toBe("B"))
    await waitFor(() => expect(restoring).toBe(false))
    const current = registry, b = createIdbPersister("B"), bApplication = createIdbPersister("B", "application")
    await act(async () => { await b.restoreClient(); }) ; await act(async () => { await bApplication.restoreClient() })
    act(() => current.queryClient.setQueryData(["private", "B"], { current: "B" }))
    await act(async () => { await set("alook:qc:v2:A:client", "late original A"); }) ; await act(async () => { await set("alook:qc:v2:B:client", "current B") })
    await act(async () => request.resolve(Response.json({ ok: true })))
    await waitFor(async () => expect(await get("alook:qc:v2:A:client")).toBeUndefined())
    expect(await get("alook:qc:v2:B:client")).toBe("current B"); expect(await b.isCurrent()).toBe(true); expect(await bApplication.isCurrent()).toBe(true)
    expect(original.runtime.lifecycle.get().active).toBe(false); expect(original.queryClient.getQueryCache().getAll()).toHaveLength(0)
    expect(current.runtime.lifecycle.get().active).toBe(true); expect(current.queryClient.getQueryData(["private", "B"])).toEqual({ current: "B" })
    expect(request.signal.aborted).toBe(true); expect(onDeleted).not.toHaveBeenCalled(); expect(replace).not.toHaveBeenCalled(); expect(reload).not.toHaveBeenCalled()
  })
  it("current positive deletion retires its actual parent and navigates even if the parent callback rejects", async () => {
    onDeleted.mockRejectedValue(new Error("parent callback failed"))
    render(<App />); const request = await deleteRequest(); const original = registry
    await act(async () => request.resolve(Response.json({ ok: true })))
    await act(async () => { await vi.waitFor(() => expect(replace).toHaveBeenCalledOnce()) })
    expect(onDeleted).toHaveBeenCalledOnce(); expect(original.runtime.lifecycle.get().active).toBe(false); expect(replace).toHaveBeenCalledWith("/sign-in?account_deleted=1")
  })
  it("a successful deletion callback held across B replacement cannot navigate B on completion", async () => {
    let finish!: () => void; onDeleted.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve }))
    const view = render(<App />); const request = await deleteRequest()
    await act(async () => request.resolve(Response.json({ ok: true })))
    await act(async () => { await vi.waitFor(() => expect(finish).toBeTypeOf("function")) })
    sdk.id = "B"; await act(async () => { view.rerender(<App id="B" deletion={false} />) }); await act(async () => { await vi.advanceTimersByTimeAsync(0) }); vi.useRealTimers(); await waitFor(() => expect(registry.accountId).toBe("B")); await waitFor(() => expect(restoring).toBe(false))
    await act(async () => finish()); expect(replace).not.toHaveBeenCalled(); expect(registry.runtime.lifecycle.get().active).toBe(true)
  })
})
