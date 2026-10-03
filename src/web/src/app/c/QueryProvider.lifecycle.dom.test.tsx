import { useLayoutEffect } from "react"
import "fake-indexeddb/auto"
import React from "react"
import { useIsRestoring, useMutation, useQueryClient } from "@tanstack/react-query"
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest"
import { act, render, waitFor } from "@/test/react-dom-harness"
import { QueryProvider } from "./QueryProvider"
import { getCommunityDbRegistry, type CommunityDbRegistry } from "@/lib/community-db/collections"
import { useCommunityMutationOrigin } from "@/hooks/community/community-origin"
import { clearAllPersistedCaches, createIdbPersister, CACHE_INVALIDATION_STORAGE_KEY } from "@/lib/query-persister"
import { useAccountSignOut } from "@/hooks/community/use-account-sign-out"
import { useApplicationOwner, type ApplicationOwner } from "@/lib/application-owner"
import { FileDownloadButton } from "@/components/file-download-button"
const identity = vi.hoisted(() => ({ id: "A", signOut: vi.fn(), download: vi.fn(), success: vi.fn(), error: vi.fn() }))
vi.mock("@/lib/auth-client", () => { const sessionSDK = { useSession: () => ({ data: { user: { id: identity.id } }, isPending: false, error: null }), signOut: (...args: unknown[]) => identity.signOut(...args) }; return { ...sessionSDK, signOutWithOrigin: async (assertActive: () => void, ...args: unknown[]) => { assertActive(); const result = await sessionSDK.signOut(...args); assertActive(); return result }, currentSessionViewer: () => { const value = sessionSDK.useSession(); return !value || value.isPending || value.error ? undefined : value.data?.user.id ?? null } } })
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }) }))
vi.mock("@tanstack/react-query-devtools", () => ({ ReactQueryDevtools: () => null }))
vi.mock("@/lib/file-save", async (importOriginal) => ({ ...await importOriginal<object>(), downloadUrl: identity.download }))
vi.mock("sonner", () => ({ toast: { success: identity.success, error: identity.error } }))
let registry: CommunityDbRegistry
let restoring: boolean
let application: ApplicationOwner
let command: () => Promise<unknown>
let logout: () => Promise<boolean>
let complete: (response: Response) => void
let assign: ReturnType<typeof vi.fn>, reload: ReturnType<typeof vi.fn>
function Probe() {
  const currentRestoring = useIsRestoring(); useLayoutEffect(() => { restoring = currentRestoring })
  const client = useQueryClient(), currentRegistry = getCommunityDbRegistry(client)!; useLayoutEffect(() => { registry = currentRegistry })
  const currentApplication = useApplicationOwner(); useLayoutEffect(() => { application = currentApplication })
  const origin = useCommunityMutationOrigin(); const mutation = useMutation({ mutationFn: () => origin.fetch("/api/community/private") }); useLayoutEffect(() => { command = () => mutation.mutateAsync() })
  const signOut = useAccountSignOut(); useLayoutEffect(() => { logout = () => signOut.mutateAsync() })
  return <div>{currentRegistry.accountId}</div>
}
function App({ id = identity.id, download = false }: { id?: string; download?: boolean }) { return <QueryProvider userId={id}><Probe />{download && <FileDownloadButton url="/private/file" filename="a.pdf">Get file</FileDownloadButton>}</QueryProvider> }
const payload = { timestamp: Date.now(), buster: "v3", clientState: { queries: [], mutations: [] } }
beforeEach(async () => {
  await act(async () => { await clearAllPersistedCaches(); }) ; identity.id = "A"; identity.signOut.mockReset(); identity.download.mockReset(); identity.success.mockReset(); identity.error.mockReset(); registry = undefined as unknown as CommunityDbRegistry
  assign = vi.fn(); reload = vi.fn(); const real = window
  vi.stubGlobal("window", new Proxy(real, { get(target, key) { return key === "location" ? { origin: "https://alook.test", assign, reload } : Reflect.get(target, key, target) } }))
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { complete = resolve })))
})
afterEach(async () => {
  await act(async () => {
    vi.unstubAllGlobals(); registry?.queryClient.clear()
  })
})
describe("actual native community account provider", () => {
  it("the actual community entry owns file IO with the same client and account lifetime", async () => {
    identity.download.mockResolvedValue({ status: "saved" })
    const mounted = render(<App download />)
    await waitFor(() => expect(registry?.authenticationView.get().active).toBe(true))
    expect(application.queryClient).toBe(registry.queryClient)
    expect(application.lifecycle).toBe(registry.runtime.lifecycle)
    await act(async () => mounted.getByRole("button").click())
    await waitFor(() => expect(mounted.getByRole("status")).toHaveTextContent("Saved"))
    expect(identity.download).toHaveBeenCalledWith("/private/file", "a.pdf", expect.objectContaining({ signal: expect.any(AbortSignal), assertActive: expect.any(Function) }))
    expect(identity.success).toHaveBeenCalledOnce()
  })
  it("an account replacement cancels held native file IO and suppresses its saved receipt", async () => {
    let finish!: (value: { status: "saved" }) => void
    identity.download.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    const mounted = render(<App download />)
    await waitFor(() => expect(registry?.authenticationView.get().active).toBe(true))
    const old = application
    await act(async () => mounted.getByRole("button").click())
    await waitFor(() => expect(identity.download).toHaveBeenCalledOnce())
    const options = identity.download.mock.calls[0]![2] as { signal: AbortSignal; assertActive: () => void }
    identity.id = "B"
    await act(async () => mounted.rerender(<App id="B" download />))
    await waitFor(() => expect(application.userId).toBe("B"))
    await waitFor(() => expect(options.signal.aborted).toBe(true))
    expect(old.lifecycle.get().active).toBe(false)
    expect(() => options.assertActive()).toThrow()
    await act(async () => finish({ status: "saved" }))
    expect(mounted.getByRole("status")).toHaveTextContent("")
    expect(application.queryClient).not.toBe(old.queryClient)
    expect(identity.success).not.toHaveBeenCalled()
    expect(identity.error).not.toHaveBeenCalled()
  })
  it("current 401 retires canonical native facts and both disk domains before navigation", async () => {
    render(<App />); await waitFor(() => expect(registry?.authenticationView.get().active).toBe(true)); await waitFor(() => expect(restoring).toBe(false)); await act(async () => { await registry.preload() })
    const old = registry, community = createIdbPersister("A"), application = createIdbPersister("A", "application"); await act(async () => { await community.persistClient(payload); }) ; await act(async () => { await application.persistClient(payload) })
    let done!: ReturnType<typeof command>; await act(async () => { done = command().catch((error) => error) }) ; await waitFor(() => expect(complete).toBeTypeOf("function")); await act(async () => { complete(new Response("{}", { status: 401 })); await done })
    await waitFor(() => expect(assign).toHaveBeenCalledOnce()); expect(old.runtime.lifecycle.get().active).toBe(false); expect(old.queryClient.getQueryCache().getAll()).toHaveLength(0)
    expect(await community.isCurrent()).toBe(false); expect(await application.isCurrent()).toBe(false); expect(reload).not.toHaveBeenCalled()
  })
  it("direct provider identity change creates B rather than reusing A's native instances", async () => {
    const mounted = render(<App />); await waitFor(() => expect(registry?.authenticationView.get().active).toBe(true)); await waitFor(() => expect(restoring).toBe(false)); await act(async () => { await registry.preload() }); const old = registry
    let done!: ReturnType<typeof command>; await act(async () => { done = command().catch((error) => error) }) ; await waitFor(() => expect(complete).toBeTypeOf("function")); const oldResponse = complete
    identity.id = "B"; await act(async () => mounted.rerender(<App id="B" />)); await waitFor(() => expect(registry?.accountId).toBe("B")); await waitFor(() => expect(restoring).toBe(false)); await act(async () => { await registry.preload() })
    await act(async () => registry.queryClient.setQueryData(["current"], { private: "B" })); await act(async () => oldResponse(new Response("{}", { status: 401 }))); expect(await done).toMatchObject({ name: "AbortError" })
    expect(registry.queryClient).not.toBe(old.queryClient); expect(registry.runtime.ui).not.toBe(old.runtime.ui); expect(registry.runtime.lifecycle.get().active).toBe(true); expect(registry.queryClient.getQueryData(["current"])).toEqual({ private: "B" }); expect(assign).not.toHaveBeenCalled(); expect(reload).not.toHaveBeenCalled()
  })
  it("all-device invalidation retires this native account and releases its DB collections", async () => {
    render(<App />); await waitFor(() => expect(registry?.authenticationView.get().active).toBe(true)); await waitFor(() => expect(restoring).toBe(false)); await act(async () => { await registry.preload() }); const old = registry
    await act(async () => old.queryClient.setQueryData(["private"], { private: "A" })); await act(async () => clearAllPersistedCaches())
    await waitFor(() => expect(old.runtime.lifecycle.get().active).toBe(false)); await waitFor(() => expect(old.queryClient.getQueryCache().getAll()).toHaveLength(0)); expect(reload).toHaveBeenCalledOnce()
  })
  it("an untrusted storage hint cannot retire a durably eligible native owner", async () => {
    render(<App />); await waitFor(() => expect(registry?.authenticationView.get().active).toBe(true)); await waitFor(() => expect(restoring).toBe(false)); await act(async () => { await registry.preload() })
    await act(async () => window.dispatchEvent(new StorageEvent("storage", { key: CACHE_INVALIDATION_STORAGE_KEY, newValue: "hint" }))); await act(async () => { await new Promise((done) => setTimeout(done, 0)) })
    expect(registry.runtime.lifecycle.get().active).toBe(true); expect(reload).not.toHaveBeenCalled()
  })
  it("native community logout confirms SDK success then clears its original account", async () => {
    identity.signOut.mockImplementation(async (options) => { options.fetchOptions.onRequest(); options.fetchOptions.onSuccess(); return { data: { success: true } } })
    render(<App />); await waitFor(() => expect(registry?.authenticationView.get().active).toBe(true)); await waitFor(() => expect(restoring).toBe(false)); await act(async () => { await registry.preload() }); const original = registry, disk = createIdbPersister("A"); await act(async () => { await disk.persistClient(payload) })
    let navigate: boolean | undefined; await act(async () => { navigate = await logout() }); expect(navigate).toBe(true); expect(original.runtime.lifecycle.get().active).toBe(false); expect(await disk.isCurrent()).toBe(false)
  })
  it("current SDK logout failure keeps the native account and facts active", async () => {
    identity.signOut.mockResolvedValue({ error: { message: "Cannot log out" } })
    render(<App />); await waitFor(() => expect(registry?.authenticationView.get().active).toBe(true)); await waitFor(() => expect(restoring).toBe(false)); await act(async () => { await registry.preload() }); await act(async () => registry.queryClient.setQueryData(["private"], { private: "A" }))
    await act(async () => { await expect(logout()).rejects.toThrow("Cannot log out") }); expect(registry.runtime.lifecycle.get().active).toBe(true); expect(registry.queryClient.getQueryData(["private"])).toEqual({ private: "A" })
  })
})
