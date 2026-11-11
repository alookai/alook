import { createElement, type PropsWithChildren } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@/test/react-dom-harness"
import { CommunityTestProvider } from "@/test/community-owner-fixture"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { retireCommunityAccount } from "@/lib/community/account-cache-lifecycle"
import { useQuery } from "@tanstack/react-query"
import { createSessionTransport } from "@/lib/session-transport"
import { useAccountAttention } from "./community/use-account-attention"
import { useAccountReadState } from "./community/community-ws/read-state-reconciliation"
import { attentionSnapshotScenarioFixture } from "@/test/community-resource-fixtures"
import { useAccountSignOut } from "./community/use-account-sign-out"

const sdk = vi.hoisted(() => vi.fn())
const sessionCheck = vi.hoisted(() => vi.fn())
const read = vi.hoisted(() => vi.fn())
vi.mock("@/lib/api/client", async importOriginal => ({ ...await importOriginal<typeof import("@/lib/api/client")>(), apiFetch: (...args: unknown[]) => read(...args) }))
vi.mock("@/lib/auth-client", () => ({ signOutWithOrigin: sdk, authClient: { getSession: sessionCheck } }))
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }) }))
beforeEach(() => { sdk.mockReset(); sessionCheck.mockReset().mockResolvedValue({ data: { user: { id: "viewer" } } }) })
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}
async function setup(domain: "community" | "application", disk = Promise.resolve(), initial = { viewer: "viewer" as string | null | undefined }) {
  const community = await createCommunityQueryOwner()
  let viewer = initial.viewer
  const retireDisk = vi.fn(() => disk)
  community.registry.bindAuthentication(() => viewer, retireDisk)
  const wrapper = ({ children }: PropsWithChildren) => createElement(CommunityTestProvider, { client: community.client, registry: community.registry, retainOwner: true }, children)
  const useCommand = useAccountSignOut
  const view = renderHook(() => useCommand(), { wrapper })
  return { view, wrapper, community, retireDisk, changeViewer: () => { viewer = "replacement" }, retire: () => retireCommunityAccount(community.registry), retired: () => !community.runtime.lifecycle.get().active }
}
describe.each(["community"] as const)("Native %s sign-out facade", (domain) => {
  it("restores actual page readers after failed logout, including retry-disabled queries", async () => {
    const owner = await setup(domain), held = deferred()
    const native = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input)
      return Response.json(path.endsWith("read-state") ? { revision: 8, readStates: [] }
        : path.endsWith("attention") ? attentionSnapshotScenarioFixture({ scopes: [], items: [], limit: 100, truncated: false, included: { servers: [], channels: [], dms: [], profiles: [], messages: [] } })
        : { value: "fresh" })
    })
    const transport = createSessionTransport(native, "http://localhost")
    read.mockImplementation(async (path, options) => (await transport.fetch(path, options)).json())
    sdk.mockImplementation(async (assert: () => void) => {
      const lease = transport.beginSignOut(assert)
      try { await lease.drain(); await held.promise; return { error: { message: "Logout failed" } } }
      finally { lease.release() }
    })
    let request!: Promise<unknown>
    act(() => { request = owner.view.result.current.mutateAsync().catch(error => error) })
    await waitFor(() => expect(sdk).toHaveBeenCalledOnce())
    const readers = renderHook(() => ({
      readState: useAccountReadState(), attention: useAccountAttention(),
      other: useQuery({ queryKey: ["retry-disabled"], retry: false, queryFn: ({ signal }) => read("/api/community/other", { signal }) }),
    }), { wrapper: owner.wrapper })
    await waitFor(() => {
      expect(readers.result.current.readState.error?.name).toBe("AbortError")
      expect(readers.result.current.attention.error?.name).toBe("AbortError")
      expect(readers.result.current.other.error?.name).toBe("AbortError")
    })
    expect(native).not.toHaveBeenCalled()
    await act(async () => { held.resolve(); expect(await request).toMatchObject({ message: "Logout failed" }) })
    await waitFor(() => {
      expect(readers.result.current.readState.data).toEqual({ revision: 8 })
      if (readers.result.current.attention.error) throw readers.result.current.attention.error
      expect(readers.result.current.attention.isSuccess).toBe(true)
      expect(readers.result.current.other.data).toEqual({ value: "fresh" })
    }, { timeout: 3000 })
    expect(owner.retired()).toBe(false)
    expect(owner.retireDisk).not.toHaveBeenCalled()
    readers.unmount()
  })
  it("does not restore A reads while queued B identity is unresolved or after B succeeds", async () => {
    const owner = await setup(domain), held = deferred()
    const invalidate = vi.spyOn(owner.community.client, "invalidateQueries")
    sdk.mockResolvedValue({ error: { message: "Logout failed" } })
    sessionCheck.mockImplementation(async () => { await held.promise; return { data: { user: { id: "B" } } } })
    let request!: Promise<unknown>
    act(() => { request = owner.view.result.current.mutateAsync().catch(error => error) })
    await waitFor(() => expect(sessionCheck).toHaveBeenCalledOnce())
    expect(invalidate).not.toHaveBeenCalled()
    await act(async () => { held.resolve(); expect(await request).toMatchObject({ message: "Logout failed" }) })
    expect(invalidate).not.toHaveBeenCalled()
    expect(owner.retireDisk).not.toHaveBeenCalled()
  })
  it("retires an unconfirmed cached owner without invoking a cookie-bound remote logout", async () => {
    const owner = await setup(domain, Promise.resolve(), { viewer: undefined }), onSuccess = vi.fn()
    owner.community.client.setQueryData(["private"], "cached A")
    await act(async () => { expect(await owner.view.result.current.mutateAsync(undefined, { onSuccess })).toBe(true) })
    expect(sdk).not.toHaveBeenCalled()
    expect(owner.retired()).toBe(true)
    expect(owner.retireDisk).toHaveBeenCalledOnce()
    expect(owner.community.client.getQueryCache().getAll()).toEqual([])
    expect(onSuccess).toHaveBeenCalledOnce()
  })
  it("withholds cached logout navigation when B arrives during local disk retirement", async () => {
    const disk = deferred(), owner = await setup(domain, disk.promise, { viewer: undefined }), onSuccess = vi.fn(), onSettled = vi.fn()
    let request!: Promise<boolean>
    act(() => { request = owner.view.result.current.mutateAsync(undefined, { onSuccess, onSettled }) })
    await waitFor(() => expect(owner.retired()).toBe(true))
    owner.changeViewer()
    await act(async () => { disk.resolve(); expect(await request).toBe(false) })
    expect(sdk).not.toHaveBeenCalled()
    expect(owner.retireDisk).toHaveBeenCalledOnce()
    expect(onSuccess).not.toHaveBeenCalled()
    expect(onSettled).not.toHaveBeenCalled()
  })
  it("keeps public methods stable and delivers void input after its authorized retirement", async () => {
    const held = deferred(), owner = await setup(domain), onSuccess = vi.fn(), onSettled = vi.fn()
    sdk.mockImplementation(async (assert: () => void) => { assert(); await held.promise; assert(); return {} })
    const methods = [owner.view.result.current.mutate, owner.view.result.current.mutateAsync]
    owner.view.rerender()
    expect([owner.view.result.current.mutate, owner.view.result.current.mutateAsync]).toEqual(methods)
    let request!: Promise<boolean>
    act(() => { request = owner.view.result.current.mutateAsync(undefined, { onSuccess, onSettled }) })
    await waitFor(() => expect(sdk).toHaveBeenCalledOnce())
    owner.view.rerender()
    expect([owner.view.result.current.mutate, owner.view.result.current.mutateAsync]).toEqual(methods)
    await act(async () => { held.resolve(); expect(await request).toBe(true) })
    expect(owner.retired()).toBe(true)
    expect(onSuccess).toHaveBeenCalledOnce(); expect(onSuccess.mock.calls[0][1]).toBeUndefined()
    expect(onSettled).toHaveBeenCalledOnce(); expect(onSettled.mock.calls[0][2]).toBeUndefined()
  })
  it("suppresses all per-call callbacks when its original owner retires during the SDK request", async () => {
    const held = deferred(), owner = await setup(domain), onSuccess = vi.fn(), onError = vi.fn(), onSettled = vi.fn()
    const invalidate = vi.spyOn(owner.community.client, "invalidateQueries")
    sdk.mockImplementation(async (assert: () => void) => { assert(); await held.promise; assert(); return {} })
    let request!: Promise<unknown>
    act(() => { request = owner.view.result.current.mutateAsync(undefined, { onSuccess, onError, onSettled }).catch((error) => error) })
    await waitFor(() => expect(sdk).toHaveBeenCalledOnce())
    act(() => owner.retire())
    await act(async () => { held.resolve(); expect(await request).toMatchObject({ name: "AbortError" }) })
    expect(onSuccess).not.toHaveBeenCalled(); expect(onError).not.toHaveBeenCalled(); expect(onSettled).not.toHaveBeenCalled()
    expect(invalidate).not.toHaveBeenCalled()
  })
  it("returns an unauthorized completion and withholds callbacks when the viewer changes during disk retirement", async () => {
    const disk = deferred(), owner = await setup(domain, disk.promise), onSuccess = vi.fn(), onSettled = vi.fn()
    sdk.mockImplementation(async (assert: () => void) => { assert(); return {} })
    let request!: Promise<boolean>
    act(() => { request = owner.view.result.current.mutateAsync(undefined, { onSuccess, onSettled }) })
    await waitFor(() => expect(owner.retired()).toBe(true))
    owner.changeViewer()
    await act(async () => { disk.resolve(); expect(await request).toBe(false) })
    expect(onSuccess).not.toHaveBeenCalled(); expect(onSettled).not.toHaveBeenCalled()
  })
})
