import { useLayoutEffect } from "react"
import "fake-indexeddb/auto"
import React from "react"
import { QueryClient, useIsRestoring, useQueryClient } from "@tanstack/react-query"
import { get, set } from "idb-keyval"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, render, waitFor } from "@/test/react-dom-harness"
import { PublicQueryProvider, useApplicationOwner, type ApplicationOwner } from "./application-owner"
import { QueryProvider } from "@/app/c/QueryProvider"
import { PERSIST_BUSTER, clearAllPersistedCaches, createIdbPersister } from "./query-persister"
import { getCommunityDbRegistry, type CommunityDbRegistry } from "./community-db/collections"
const sdk = vi.hoisted(() => ({ session: { data: { user: { id: "A" } } as { user: { id: string } } | null, isPending: false, error: null } }))
vi.mock("@/lib/auth-client", () => { const sessionSDK = { useSession: () => sdk.session }; return { ...sessionSDK, currentSessionViewer: () => { const value = sessionSDK.useSession(); return !value || value.isPending || value.error ? undefined : value.data?.user.id ?? null } } })
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }) }))
vi.mock("@tanstack/react-query-devtools", () => ({ ReactQueryDevtools: () => null }))
let application: ApplicationOwner, community: CommunityDbRegistry
const clients: QueryClient[] = []
function AppProbe() { const restoring = useIsRestoring(); const current = useApplicationOwner(); useLayoutEffect(() => { application = current; clients.push(current.queryClient) }); return <p data-restoring={String(restoring)}>Application</p> }
function CommunityProbe() { const restoring = useIsRestoring(); const client = useQueryClient(); const current = getCommunityDbRegistry(client)!; useLayoutEffect(() => { community = current; clients.push(client) }); return <p data-restoring={String(restoring)}>Community</p> }
function Root({ kind, id, show = true }: { kind: "application" | "community"; id: string; show?: boolean }) {
  if (!show) return <p>Other route</p>
  return kind === "application" ? <PublicQueryProvider><AppProbe /></PublicQueryProvider> : <QueryProvider userId={id}><CommunityProbe /></QueryProvider>
}
const payload = { timestamp: Date.now(), buster: PERSIST_BUSTER, clientState: { queries: [], mutations: [] } }
beforeEach(async () => { await act(async () => { await clearAllPersistedCaches(); }) ; sdk.session = { data: { user: { id: "A" } }, isPending: false, error: null }; const real = window; vi.stubGlobal("window", new Proxy(real, { get: (target, key) => key === "location" ? { reload: vi.fn(), assign: vi.fn() } : Reflect.get(target, key, target) })) })
afterEach(async () => {
  await act(async () => {
    vi.unstubAllGlobals(); for (const client of clients.splice(0)) client.clear()
  })
})
describe.each(["application", "community"] as const)("%s original public SDK identity", (kind) => {
  it("retires old A disk through keyed A-to-B replacement with immutable SDK output", async () => {
    const view = render(<Root kind={kind} id="A" />)
    await waitFor(() => expect(kind === "application" ? application?.userId : community?.accountId).toBe("A"))
    await waitFor(() => expect(view.getByText(kind === "application" ? "Application" : "Community")).toHaveAttribute("data-restoring", "false"))
    const old = kind === "application" ? application : community
    const a = createIdbPersister("A"), b = createIdbPersister("B")
    await act(async () => { await a.persistClient(payload); }) ; await act(async () => { await b.persistClient(payload); }) ; await act(async () => { await set("alook:qc:v2:A:client", "old A"); }) ; await act(async () => { await set("alook:qc:v2:B:client", "old B") })
    sdk.session = { data: { user: { id: "B" } }, isPending: false, error: null }
    await act(async () => view.rerender(<Root kind={kind} id="B" />))
    await waitFor(() => expect(kind === "application" ? application.userId : community.accountId).toBe("B"))
    await waitFor(() => expect(view.getByText(kind === "application" ? "Application" : "Community")).toHaveAttribute("data-restoring", "false"))
    await waitFor(async () => expect(await a.isCurrent()).toBe(false))
    expect(await get("alook:qc:v2:A:client")).toBeUndefined(); expect(await get("alook:qc:v2:B:client")).toBeUndefined(); expect(await b.isCurrent()).toBe(true); expect((await b.restoreClient())?.timestamp).toBe(payload.timestamp)
    expect(kind === "application" ? (old as ApplicationOwner).lifecycle.get().active : (old as CommunityDbRegistry).runtime.lifecycle.get().active).toBe(false)
  })
  it("keeps same-viewer disk eligibility through ordinary route unmount", async () => {
    const view = render(<Root kind={kind} id="A" />)
    await waitFor(() => expect(kind === "application" ? application?.userId : community?.accountId).toBe("A"))
    const a = createIdbPersister("A"); await act(async () => { await a.persistClient(payload); }) ; await act(async () => { await set("alook:qc:v2:A:client", "old A") })
    await act(async () => view.rerender(<Root kind={kind} id="A" show={false} />))
    await act(async () => { await new Promise((done) => setTimeout(done, 0)) })
    expect(await a.isCurrent()).toBe(true); expect(await get("alook:qc:v2:A:client")).toBe("old A")
  })
  it("retires known A when public SDK reports signed out before root unmount", async () => {
    const view = render(<Root kind={kind} id="A" />)
    await waitFor(() => expect(kind === "application" ? application?.userId : community?.accountId).toBe("A"))
    const a = createIdbPersister("A"); await act(async () => { await a.persistClient(payload) })
    sdk.session = { data: null, isPending: false, error: null }
    await act(async () => view.rerender(<Root kind={kind} id="A" />))
    await waitFor(async () => expect(await a.isCurrent()).toBe(false))
    await act(async () => view.rerender(<Root kind={kind} id="A" show={false} />))
  })
})
