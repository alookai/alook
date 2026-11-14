import { BUSINESS_SCHEMA_VERSION, COMMUNITY_CONTRACT_HEADER } from "@alook/shared"
import { get, set } from "idb-keyval"
import { useLayoutEffect } from "react"
import "fake-indexeddb/auto"
import React from "react"
import { useIsRestoring, useMutation, useQueryClient } from "@tanstack/react-query"
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest"
import { act, render, waitFor } from "@/test/react-dom-harness"
import { QueryProvider } from "./QueryProvider"
import { getCommunityDbRegistry, type CommunityDbRegistry } from "@/lib/community-db/collections"
import { useCommunityMutationOrigin } from "@/hooks/community/community-origin"
import { clearAllPersistedCaches, createIdbPersister, CACHE_INVALIDATION_STORAGE_KEY, PERSIST_BUSTER, PERSIST_CACHE_PREFIX, type QualifiedPersister } from "@/lib/query-persister"
import { communityKeys } from "@/lib/query-keys"
import { fullResourceBundleFixture, serverResourceFixture } from "@/test/community-resource-fixtures"
import { conversationEntryFixture, conversationEntryTarget } from "@/test/conversation-entry-fixtures"
import { conversationEntryOptions, publishConversationEntry } from "@/lib/community/conversation-entry"
import { captureCommunityLiveSnapshotToken, publishCommunityResourceBundle } from "@/lib/community-db/sync"
import { businessSchemaLifecycle, registerBusinessSchemaOwner, requestBusinessSchemaUpdate, requestDocumentBuildUpdate } from "@/lib/business-schema-lifecycle"
import { useAccountSignOut } from "@/hooks/community/use-account-sign-out"
import { useApplicationOwner, type ApplicationOwner } from "@/lib/application-owner"
import { FileDownloadButton } from "@/components/file-download-button"
const identity = vi.hoisted(() => ({ id: "A", signOut: vi.fn(), download: vi.fn(), success: vi.fn(), error: vi.fn() }))
const storage = vi.hoisted(() => ({ writers: [] as QualifiedPersister[], saves: [] as Array<{ writer: number; messageIds: string[]; started: number; completed?: number; error?: string; promise: Promise<unknown> }> }))
vi.mock("@/lib/query-persister", async original => {
  const actual = await original<typeof import("@/lib/query-persister")>()
  return { ...actual, createIdbPersister: (id: string | null) => {
    const writer = actual.createIdbPersister(id)
    const index = storage.writers.length, persist = writer.persistClient.bind(writer)
    writer.persistClient = client => {
      const result = persist(client)
      const call = { writer: index, messageIds: client.clientState.queries.flatMap(query => query.queryKey[1] === "db" && query.queryKey[3] === "messages" && Array.isArray(query.state.data) ? query.state.data.map(row => row.id as string) : []), started: Date.now(), promise: Promise.resolve(result) } as typeof storage.saves[number]
      storage.saves.push(call)
      void call.promise.then(() => { call.completed = Date.now() }, error => { call.error = String(error) })
      return result
    }
    storage.writers.push(writer)
    return writer
  } }
})
vi.mock("@/lib/auth-client", () => { const sessionSDK = { useSession: () => ({ data: { user: { id: identity.id } }, isPending: false, error: null }), signOut: (...args: unknown[]) => identity.signOut(...args) }; return { ...sessionSDK, authClient: { getSession: async () => ({ data: { user: { id: identity.id } }, error: null }) }, signOutWithOrigin: async (assertActive: () => void, ...args: unknown[]) => { assertActive(); const result = await sessionSDK.signOut(...args); assertActive(); return result }, currentSessionViewer: () => { const value = sessionSDK.useSession(); return !value || value.isPending || value.error ? undefined : value.data?.user.id ?? null } } })
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
  storage.writers = []
  storage.saves = []
  businessSchemaLifecycle.setState(() => ({ phase: "current", expectedVersion: BUSINESS_SCHEMA_VERSION }))
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
  it.each(["preserve", "account", "permission", "schema"] as const)("keeps the actual cache result after queued build retirement and later %s", async retirement => {
    const mounted = render(<App />)
    await waitFor(() => expect(registry?.authenticationView.get().active).toBe(true))
    await waitFor(() => expect(restoring).toBe(false))
    const old = registry, writer = storage.writers[0]!
    const packet = conversationEntryFixture()
    packet.viewerId = "A"
    packet.channel.creatorId = "A"
    await act(async () => {
      await old.preload()
      await publishCommunityResourceBundle(old.queryClient, fullResourceBundleFixture("A", [serverResourceFixture({ ownerId: "A" })], []), { token: captureCommunityLiveSnapshotToken(old.queryClient, "c1") })
      const resource = await publishConversationEntry(old.queryClient, conversationEntryTarget, packet, {
        token: captureCommunityLiveSnapshotToken(old.queryClient, "c1"),
      })
      old.queryClient.setQueryData(conversationEntryOptions(old.queryClient, conversationEntryTarget).queryKey, resource)
    })
    const payloadKey = `${PERSIST_CACHE_PREFIX}:A:client`
    const prepared = storage.saves.filter(call => call.writer === storage.writers.indexOf(writer))
    expect(prepared.some(call => call.messageIds.includes("m1"))).toBe(true)
    await Promise.all(prepared.map(call => call.promise))
    expect(prepared.every(call => call.completed !== undefined && call.error === undefined)).toBe(true)
    console.info("315-provider-native-preparation", JSON.stringify({ retirement, actualWriterCalls: prepared.length,
      longestNativeCompletionMS: Math.max(...prepared.map(call => call.completed! - call.started)), messageId: "m1", completed: true }))
    await waitFor(async () => {
      const restored = await createIdbPersister("A").restoreClient()
      expect(restored?.clientState.queries.find(query => JSON.stringify(query.queryKey) === JSON.stringify(communityKeys.communityDbCollection("A", "messages")))?.state.data).toEqual(expect.arrayContaining([expect.objectContaining({ id: "m1" })]))
    })
    const before = await get(payloadKey)
    let done!: Promise<unknown>
    await act(async () => { done = command().catch(error => error) })
    await waitFor(() => expect(complete).toBeTypeOf("function"))
    const lateResponse = complete
    const replace = vi.fn(), base = window
    vi.stubGlobal("window", new Proxy(base, { get(target, key) {
      return key === "location" ? { href: "https://alook.test/c/channels/s1/c1", origin: "https://alook.test", replace, reload, assign } : Reflect.get(target, key, target)
    } }))
    vi.stubGlobal("navigator", {})
    sessionStorage.clear()
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const unregister = registerBusinessSchemaOwner(() => held)
    let queued!: ReturnType<QualifiedPersister["persistClient"]>
    try {
      await act(async () => {
        queued = writer.persistClient({ timestamp: Date.now(), buster: PERSIST_BUSTER, clientState: { queries: [], mutations: [] } })
        requestDocumentBuildUpdate("next-build")
      })
      expect(old.runtime.lifecycle.get().active).toBe(false)
      expect(replace).not.toHaveBeenCalled()
      await act(async () => {
        if (retirement === "account") { identity.id = "B"; mounted.rerender(<App id="B" />) }
        if (retirement === "permission") await writer.retireChannels(["c1"])
        if (retirement === "schema") requestBusinessSchemaUpdate(BUSINESS_SCHEMA_VERSION + 1)
        release()
      })
      await waitFor(() => expect(replace).toHaveBeenCalledOnce())
      await act(async () => mounted.unmount())
      await act(async () => { lateResponse(Response.json({ late: true }, { headers: { [COMMUNITY_CONTRACT_HEADER]: String(BUSINESS_SCHEMA_VERSION) } })); await queued })
      expect(await done).toMatchObject({ name: "AbortError" })
      await waitFor(() => expect(old.queryClient.getQueryCache().getAll()).toHaveLength(0))
      const settled = storage.saves.filter(call => call.writer === storage.writers.indexOf(writer))
      await Promise.all(settled.map(call => call.promise))
      expect(settled.every(call => call.completed !== undefined && call.error === undefined)).toBe(true)
      console.info("315-provider-native-terminal", JSON.stringify({ retirement, actualWriterCalls: settled.length,
        longestNativeCompletionMS: Math.max(...settled.map(call => call.completed! - call.started)), completed: true }))
      if (retirement === "preserve") expect(await get(payloadKey)).toBe(before)
      if (retirement === "account" || retirement === "schema") expect(await writer.isCurrent()).toBe(false)
      const fresh = createIdbPersister("A")
      const restored = await fresh.restoreClient()
      const messages = restored?.clientState.queries.find(query => JSON.stringify(query.queryKey) === JSON.stringify(communityKeys.communityDbCollection("A", "messages")))?.state.data
      if (retirement === "preserve") expect(messages).toEqual(expect.arrayContaining([expect.objectContaining({ id: "m1" })]))
      else expect(messages ?? []).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: "m1" })]))
    } finally { release(); unregister() }
  })
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
    const old = registry, community = createIdbPersister("A"); await act(async () => { await community.persistClient(payload); }) ; await act(async () => { await set("alook:qc:v3:A:application:client", JSON.stringify(payload)) })
    let done!: ReturnType<typeof command>; await act(async () => { done = command().catch((error) => error) }) ; await waitFor(() => expect(complete).toBeTypeOf("function")); await act(async () => { complete(new Response("{}", { status: 401 })); await done })
    await waitFor(() => expect(assign).toHaveBeenCalledOnce()); expect(old.runtime.lifecycle.get().active).toBe(false); expect(old.queryClient.getQueryCache().getAll()).toHaveLength(0)
    expect(await community.isCurrent()).toBe(false); expect(await get("alook:qc:v3:A:application:client")).toBeUndefined(); expect(reload).not.toHaveBeenCalled()
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
