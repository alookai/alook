import { useLayoutEffect } from "react"
import "fake-indexeddb/auto"
import React from "react"
import { QueryClient, useQueryClient } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, render, screen, waitFor } from "@/test/react-dom-harness"
import { QueryProvider } from "@/app/c/QueryProvider"
import { clearAllPersistedCaches } from "@/lib/query-persister"
import { useChannelRefDirectory } from "../use-channel-ref-directory"
import { useRenameChannel } from "./channels"
import { communityKeys } from "@/lib/query-keys"
import { getCommunityDbRegistry } from "@/lib/community-db/collections"
import { projectCommunityWsEventToDb } from "@/lib/community-db/sync"

const api = vi.hoisted(() => vi.fn())
const sdk = vi.hoisted(() => ({ session: { data: { user: { id: "A" } }, isPending: false, error: null } }))
vi.mock("@/lib/api/client", () => ({ apiFetch: api }))
vi.mock("@/lib/auth-client", () => { const sessionSDK = { useSession: () => sdk.session }; return { ...sessionSDK, currentSessionViewer: () => { const value = sessionSDK.useSession(); return !value || value.isPending || value.error ? undefined : value.data?.user.id ?? null } } })
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), replace: vi.fn() }) }))
vi.mock("@tanstack/react-query-devtools", () => ({ ReactQueryDevtools: () => null }))
const directory = [{ id: "srv", name: "Studio", discriminator: "0001", channels: [{ id: "ch", name: "general", type: "text" as const }] }]
let current: ReturnType<typeof useRenameChannel>, currentClient: QueryClient
function Probe() {
  const data = useChannelRefDirectory(), command = useRenameChannel(), client = useQueryClient(); useLayoutEffect(() => { current = command; currentClient = client; if (!clients.includes(client)) clients.push(client) })
  return <output>{data.directory[0]?.channels[0]?.name ?? "Pending"}</output>
}
const clients: QueryClient[] = []
function Root({ id = "A" }: { id?: string }) { return <QueryProvider userId={id}><Probe /></QueryProvider> }
function deferred() { let resolve!: (data: { id: string; name: string }) => void, reject!: (error: Error) => void; const promise = new Promise<{ id: string; name: string }>((done, fail) => { resolve = done; reject = fail }); return { promise, resolve, reject } }
async function mount() {
  const held = deferred()
  const seen = new Set<string>()
  api.mockImplementation((path: string, options?: { method?: string; authenticationAccount?: string; signal?: AbortSignal }) => {
    if (options?.method === "PATCH") return held.promise
    const account = options?.authenticationAccount ?? "unknown"
    if (!seen.has(account)) { seen.add(account); return Promise.resolve({ directory }) }
    return new Promise((_, reject) => options?.signal?.addEventListener("abort", () => reject(new DOMException("Cancelled fresh read", "AbortError")), { once: true }))
  })
  const view = render(<Root />)
  await waitFor(() => expect(screen.getByText("general")).toBeTruthy())
  const qc = currentClient
  await act(async () => { await getCommunityDbRegistry(qc)!.ready })
  return { held, qc, view }
}
function ws(qc: QueryClient, name: string) { projectCommunityWsEventToDb(qc, { type: "community:channel.update", serverId: "srv", channelId: "ch", changes: { name } }) }
function rename() { return current.mutateAsync({ serverId: "srv", channelId: "ch", name: "  Proposed  " }).catch((error: unknown) => error) }
beforeEach(async () => { await clearAllPersistedCaches(); sdk.session = { data: { user: { id: "A" } }, isPending: false, error: null } })
afterEach(async () => { await act(async () => { api.mockReset(); clients.splice(0).forEach((qc) => qc.clear()) }) })

describe("native directory fact owner and channel transaction", () => {
  it("stores transport IDs only and renders both optimistic and normalized names from the DB", async () => {
    const { held, qc } = await mount()
    expect(qc.getQueryData(communityKeys.channelRefDirectory())).toEqual(["srv"])
    let result!: Promise<unknown>; act(() => { result = rename() })
    await waitFor(() => expect(screen.getByText("Proposed")).toBeTruthy())
    expect(getCommunityDbRegistry(qc)!.collections.channels.get("ch")?.name).toBe("Proposed")
    await act(async () => { held.resolve({ id: "ch", name: "proposed-normalized" }); await result })
    await waitFor(() => expect(screen.getByText("proposed-normalized")).toBeTruthy())
    expect(qc.getQueryData(communityKeys.channelRefDirectory())).toEqual(["srv"])
  })
  it("reveals a newer committed WS name after ordinary PATCH failure without restoring a DTO snapshot", async () => {
    const { held, qc } = await mount()
    let result!: Promise<unknown>; act(() => { result = rename() })
    await waitFor(() => expect(screen.getByText("Proposed")).toBeTruthy())
    act(() => ws(qc, "newer-ws"))
    await act(async () => { held.reject(new Error("duplicate")); expect(await result).toBeInstanceOf(Error) })
    await waitFor(() => expect(screen.getByText("newer-ws")).toBeTruthy())
    expect(getCommunityDbRegistry(qc)!.collections.channels.get("ch")?.name).toBe("newer-ws")
  })
  it("preserves newer WS authority when a held successful PATCH settles", async () => {
    const { held, qc } = await mount()
    let result!: Promise<unknown>; act(() => { result = rename() })
    await waitFor(() => expect(api.mock.calls.some(([, options]) => options?.method === "PATCH")).toBe(true))
    act(() => ws(qc, "newer-ws"))
    await act(async () => { held.resolve({ id: "ch", name: "old-response" }); await result })
    await waitFor(() => expect(screen.getByText("newer-ws")).toBeTruthy())
  })
  it("rejects old owner success and cannot create old transport facts or modify the new owner", async () => {
    const { held, qc, view } = await mount()
    let result!: Promise<unknown>; act(() => { result = rename() })
    await waitFor(() => expect(api.mock.calls.some(([, options]) => options?.method === "PATCH")).toBe(true))
    act(() => { sdk.session = { data: { user: { id: "B" } }, isPending: false, error: null }; view.rerender(<Root id="B" />) })
    await waitFor(() => expect(currentClient).not.toBe(qc))
    await waitFor(() => expect(screen.getByText("general")).toBeTruthy())
    const next = currentClient
    await act(async () => { held.resolve({ id: "ch", name: "old-response" }); expect(await result).toMatchObject({ name: "AbortError" }) })
    expect(getCommunityDbRegistry(next)!.collections.channels.get("ch")?.name).toBe("general")
    expect(qc.getQueryData(communityKeys.channelRefDirectory())).toBeUndefined()
  })
  it("retires the native warm read and its observers through actual QueryProvider unmount without manually clearing its client", async () => {
    const held: Array<{ signal: AbortSignal; finish: (data: { directory: typeof directory }) => void }> = []
    api.mockImplementation((_path: string, options: { signal: AbortSignal }) => new Promise((finish) => { held.push({ signal: options.signal, finish }) }))
    const view = render(<Root />)
    await waitFor(() => expect(currentClient.getQueryCache().find({ queryKey: communityKeys.channelRefDirectory() })?.getObserversCount()).toBe(2))
    const original = currentClient, resource = original.getQueryCache().find({ queryKey: communityKeys.channelRefDirectory() })!
    const { signal } = held.findLast((request) => !request.signal.aborted)!
    expect(resource.getObserversCount()).toBe(2)
    view.unmount()
    await waitFor(() => expect(signal.aborted).toBe(true))
    expect(resource.getObserversCount()).toBe(0)
    await waitFor(() => expect(original.getQueryCache().getAll()).toHaveLength(0))
    await act(async () => held.forEach((request) => request.finish({ directory })))
    expect(original.getQueryCache().getAll()).toHaveLength(0)
  })
})
