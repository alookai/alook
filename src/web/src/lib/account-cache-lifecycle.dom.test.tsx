import { get, set } from "idb-keyval"
import { useLayoutEffect } from "react"
import "fake-indexeddb/auto"
import React from "react"
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest"
import { useMutation } from "@tanstack/react-query"
import { act, render, waitFor } from "@/test/react-dom-harness"
import { PublicQueryProvider, useApplicationOwner, runApplicationRequest, type ApplicationOwner } from "./application-owner"
import { apiFetch } from "./api/client"
import { clearAllPersistedCaches, clearPersistedCache, createIdbPersister, CACHE_INVALIDATION_STORAGE_KEY } from "./query-persister"
const identity = vi.hoisted(() => ({ id: "A" }))
vi.mock("@/lib/auth-client", () => { const sessionSDK = { useSession: () => ({ data: { user: { id: identity.id } }, isPending: false, error: null }) }; return { ...sessionSDK, currentSessionViewer: () => { const value = sessionSDK.useSession(); return !value || value.isPending || value.error ? undefined : value.data?.user.id ?? null } } })
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }) }))
const owners: Record<string, ApplicationOwner> = {}
const commands: Record<string, () => Promise<unknown>> = {}
let response: (response: Response) => void
let assign: ReturnType<typeof vi.fn>
let reload: ReturnType<typeof vi.fn>
function Probe({ name }: { name: string }) {
  const owner = useApplicationOwner(); useLayoutEffect(() => { owners[name] = owner })
  const command = useMutation({ mutationFn: () => runApplicationRequest(owner, (options) => apiFetch("/api/private", options)) })
  useLayoutEffect(() => { commands[name] = () => command.mutateAsync() })
  return <output>{name}</output>
}
function App({ user = identity.id, name = user }: { user?: string; name?: string }) { return <PublicQueryProvider><Probe name={name} /></PublicQueryProvider> }
const persisted = { timestamp: Date.now(), buster: "v3", clientState: { queries: [], mutations: [] } }
beforeEach(async () => {
  await act(async () => { await clearAllPersistedCaches(); }) ; identity.id = "A"; for (const key of Object.keys(owners)) delete owners[key]; for (const key of Object.keys(commands)) delete commands[key]
  assign = vi.fn(); reload = vi.fn(); const real = window
  vi.stubGlobal("window", new Proxy(real, { get(target, key) { return key === "location" ? { origin: "https://alook.test", assign, reload } : Reflect.get(target, key, target) } }))
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { response = resolve })))
})
afterEach(async () => {
  await act(async () => {
    vi.unstubAllGlobals(); for (const owner of Object.values(owners)) owner.queryClient.clear()
  })
})
describe("native account cache lifecycle integration", () => {
  it("current mutation 401 retires its native memory and both disk domains before navigation", async () => {
    render(<App />); await waitFor(() => expect(commands.A).toBeDefined())
    const community = createIdbPersister("A")
    await act(async () => { await community.persistClient(persisted); }) ; await act(async () => { await set("alook:qc:v3:A:application:client", JSON.stringify(persisted)) })
    owners.A.queryClient.setQueryData(["application", "A", "workspace", "w", "fact"], { private: "A" })
    let done!: ReturnType<typeof commands.A>; await act(async () => { done = commands.A().catch((error) => error) })
    await waitFor(() => expect(response).toBeTypeOf("function"))
    await act(async () => { response(new Response("{}", { status: 401 })); await done }); await waitFor(() => expect(assign).toHaveBeenCalledOnce())
    expect(owners.A.lifecycle.get().active).toBe(false); expect(owners.A.queryClient.getQueryCache().getAll()).toHaveLength(0)
    expect(await community.isCurrent()).toBe(false); expect(await get("alook:qc:v3:A:application:client")).toBeUndefined()
    expect(await createIdbPersister("A").restoreClient()).toBeUndefined(); expect(await get("alook:qc:v3:A:application:client")).toBeUndefined()
    expect(reload).not.toHaveBeenCalled()
  })
  it("old mutation 401 after A to B cannot clear B, navigate, or retire the current owner", async () => {
    const mounted = render(<App />); await waitFor(() => expect(commands.A).toBeDefined()); const oldOwner = owners.A
    let done!: ReturnType<typeof commands.A>; await act(async () => { done = commands.A().catch((error) => error) }) ; await waitFor(() => expect(response).toBeTypeOf("function")); const oldResponse = response
    identity.id = "B"; await act(async () => mounted.rerender(<App user="B" />)); await waitFor(() => expect(commands.B).toBeDefined())
    owners.B.queryClient.setQueryData(["application", "B", "fact"], { current: "B" }); const bDisk = createIdbPersister("B"); await act(async () => { await bDisk.persistClient(persisted) })
    await act(async () => oldResponse(new Response("{}", { status: 401 }))); const error = await done
    expect(error).toMatchObject({ name: "AbortError" }); expect(oldOwner.lifecycle.get().active).toBe(false); expect(owners.B.lifecycle.get().active).toBe(true)
    expect(owners.B.queryClient.getQueryData(["application", "B", "fact"])).toEqual({ current: "B" }); expect(await bDisk.isCurrent()).toBe(true); expect(assign).not.toHaveBeenCalled(); expect(reload).not.toHaveBeenCalled()
  })
  it("all-device clear retires both mounted native clients and writers without a first payload", async () => {
    render(<><App name="first" /><App name="second" /></>); await waitFor(() => expect(commands.second).toBeDefined())
    const unseenB = createIdbPersister("B"); await act(async () => { await unseenB.restoreClient() })
    owners.first.queryClient.setQueryData(["private"], { private: "A" }); owners.second.queryClient.setQueryData(["private"], { private: "A" })
    await act(async () => clearAllPersistedCaches())
    await waitFor(() => expect(owners.first.lifecycle.get().active).toBe(false)); await waitFor(() => expect(owners.second.lifecycle.get().active).toBe(false))
    expect(owners.first.queryClient.getQueryCache().getAll()).toHaveLength(0); expect(owners.second.queryClient.getQueryCache().getAll()).toHaveLength(0); expect(await unseenB.isCurrent()).toBe(false)
    await act(async () => { await unseenB.persistClient(persisted); }) ; expect(await createIdbPersister("B").restoreClient()).toBeUndefined()
  })
  it("external-document notification only retires after the original durable eligibility fails", async () => {
    render(<App />); await waitFor(() => expect(commands.A).toBeDefined()); owners.A.queryClient.setQueryData(["private"], { private: "A" })
    await act(async () => window.dispatchEvent(new StorageEvent("storage", { key: CACHE_INVALIDATION_STORAGE_KEY, newValue: "untrusted hint" })))
    await act(async () => { await new Promise((done) => setTimeout(done, 0)) }); expect(owners.A.lifecycle.get().active).toBe(true)
    vi.resetModules(); const otherDocument = await import("./query-persister"); await act(async () => { await otherDocument.clearPersistedCache("A") })
    await act(async () => window.dispatchEvent(new StorageEvent("storage", { key: CACHE_INVALIDATION_STORAGE_KEY })))
    await waitFor(() => expect(owners.A.lifecycle.get().active).toBe(false)); expect(owners.A.queryClient.getQueryData(["private"])).toBeUndefined(); expect(reload).toHaveBeenCalledOnce()
  })
  it("expiry payload removal retains the original native owner and its fresh writer", async () => {
    render(<App />); await waitFor(() => expect(commands.A).toBeDefined()); const disk = createIdbPersister("A")
    await act(async () => { await disk.persistClient(persisted); }) ; await act(async () => { await disk.removeClient(); }) ; expect(await disk.isCurrent()).toBe(true)
    await act(async () => owners.A.queryClient.setQueryData(["private"], { refreshed: "A" })); await act(async () => { await disk.persistClient({ ...persisted, timestamp: 2 }) })
    expect((await disk.restoreClient())?.timestamp).toBe(2); expect(owners.A.lifecycle.get().active).toBe(true); expect(reload).not.toHaveBeenCalled()
  })
  it("A disk retirement leaves unrelated B eligibility intact", async () => {
    const a = createIdbPersister("A"), b = createIdbPersister("B"); await act(async () => { await a.persistClient(persisted); }) ; await act(async () => { await b.persistClient(persisted) })
    await act(async () => { await clearPersistedCache("A"); }) ; expect(await a.isCurrent()).toBe(false); expect(await b.isCurrent()).toBe(true); expect((await b.restoreClient())?.timestamp).toBe(persisted.timestamp)
  })
})
