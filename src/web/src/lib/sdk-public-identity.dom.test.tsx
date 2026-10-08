import { useLayoutEffect } from "react"
import "fake-indexeddb/auto"
import React from "react"
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest"
import { act, render, waitFor } from "@/test/react-dom-harness"
import { createIdbPersister, PERSIST_BUSTER, clearAllPersistedCaches } from "./query-persister"
import { get, set } from "idb-keyval"
import { useQueryClient, useIsRestoring } from "@tanstack/react-query"
import { getCommunityDbRegistry, type CommunityDbRegistry } from "./community-db/collections"
const fetchFixture = vi.hoisted(() => {
  const transport = vi.fn()
  vi.stubGlobal("fetch", transport)
  return transport
})
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }) }))
vi.mock("@tanstack/react-query-devtools", () => ({ ReactQueryDevtools: () => null }))
let selected: string | null = "A"
const now = "2026-10-02T00:00:00.000Z"
const user = (id: string) => ({ id, name: id, email: `${id}@example.test`, emailVerified: true, createdAt: now, updatedAt: now, image: null })
const session = () => selected ? { user: user(selected), session: { id: `session-${selected}`, token: "fixture", userId: selected, expiresAt: "2026-10-20T00:00:00.000Z", createdAt: now, updatedAt: now } } : null
let auth: typeof import("./auth-client")
let Application: typeof import("./application-owner")
let Community: typeof import("@/app/c/QueryProvider")
let registry: CommunityDbRegistry
const owners: Record<string, import("./application-owner").ApplicationOwner> = {}
const restoring: Record<string, boolean> = {}
beforeAll(async () => {
  await act(async () => { await clearAllPersistedCaches() })
  fetchFixture.mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost:3000").pathname
    if (path.endsWith("/get-session")) return Response.json(session())
    if (path.endsWith("/sign-in/email")) { selected = "B"; return Response.json({ redirect: false, user: user("B"), token: "fixture" }) }
    if (path.endsWith("/sign-out")) { selected = null; return Response.json({ success: true }) }
    throw new Error(`Unexpected public SDK request ${path} ${init?.method}`)
  })
  auth = await import("./auth-client")
  Application = await import("./application-owner")
  Community = await import("@/app/c/QueryProvider")
})
afterAll(() => { vi.unstubAllGlobals(); for (const owner of Object.values(owners)) owner.queryClient.clear() })
function Probe() { const owner = Application.useApplicationOwner(); const kind = owner.userId; const pending = useIsRestoring(); useLayoutEffect(() => { owners[kind] = owner; restoring[kind] = pending }); return <output>{owner.userId}</output> }
function CommunityProbe() { const current = getCommunityDbRegistry(useQueryClient())!; useLayoutEffect(() => { registry = current }); return <output>Community</output> }
function Root() { return <Application.PublicQueryProvider><Probe /></Application.PublicQueryProvider> }
describe("real BetterAuth public session input", () => {
  it("public signIn.email updates real useSession and retires original account before B root mounts", async () => {
    const view = render(<Root />)
    await waitFor(() => expect(restoring.A).toBe(false))
    await waitFor(() => expect(auth.authClient.$store.atoms.session.get()).toMatchObject({ isPending: false, error: null, data: { user: { id: "A" } } }))
    const a = createIdbPersister("A"), b = createIdbPersister("B")
    await act(async () => { await a.restoreClient(); }) ; await act(async () => { await b.persistClient({ timestamp: Date.now(), buster: PERSIST_BUSTER, clientState: { queries: [], mutations: [] } }); }) ; await act(async () => { await set("alook:qc:v2:A:client", "old A"); }) ; await act(async () => { await set("alook:qc:v2:B:client", "old B") })
    await act(async () => { const result = await auth.authClient.signIn.email({ email: "B@example.test", password: "fixture-password" }); expect(result.error).toBeNull() })
    await waitFor(() => expect(owners.A.sessionViewer()).toBe("B"))
    await waitFor(async () => expect(await a.isCurrent()).toBe(false))
    expect(await get("alook:qc:v2:A:client")).toBeUndefined(); expect(await get("alook:qc:v2:B:client")).toBeUndefined(); expect(await b.restoreClient()).toMatchObject({ buster: PERSIST_BUSTER })
    await act(async () => view.rerender(<Root />))
    await waitFor(() => expect(restoring.B).toBe(false))
    await waitFor(() => expect(owners.B?.sessionViewer()).toBe("B")); expect(owners.B.lifecycle.get().active).toBe(true); expect(await b.isCurrent()).toBe(true)
  })
  it("public signOut updates the real community useSession and clears only B's disk", async () => {
    render(<Community.QueryProvider userId="B"><CommunityProbe /></Community.QueryProvider>)
    await waitFor(() => expect(registry?.sessionViewer()).toBe("B"))
    const original = registry, b = createIdbPersister("B"), a = createIdbPersister("A")
    await act(async () => { await b.restoreClient(); }) ; await act(async () => { await a.restoreClient(); }) ; await act(async () => { await set("alook:qc:v2:B:client", "old B"); }) ; await act(async () => { await set("alook:qc:v2:A:client", "other A") })
    await act(async () => { const result = await auth.signOut(); expect(result.error).toBeNull() })
    await waitFor(() => expect(original.sessionViewer()).toBeNull())
    await waitFor(async () => expect(await b.isCurrent()).toBe(false))
    expect(await a.isCurrent()).toBe(true); expect(await get("alook:qc:v2:A:client")).toBe("other A"); expect(await get("alook:qc:v2:B:client")).toBeUndefined()
    expect(original.runtime.lifecycle.get().active).toBe(false)
  })

})
