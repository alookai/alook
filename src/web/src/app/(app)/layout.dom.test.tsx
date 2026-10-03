import { useLayoutEffect } from "react"
import "fake-indexeddb/auto"
import React from "react"
import { get, set } from "idb-keyval"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, render, waitFor } from "@/test/react-dom-harness"
import AppLayout from "./layout"
import { useApplicationOwner, type ApplicationOwner } from "@/lib/application-owner"
import { clearAllPersistedCaches, createIdbPersister } from "@/lib/query-persister"

const input = vi.hoisted(() => ({ serverId: "A", sdk: { data: { user: { id: "A" } }, isPending: false, error: null } }))
vi.mock("@/lib/session", () => ({ getSession: async () => ({ user: { id: input.serverId } }) }))
vi.mock("@/lib/auth-client", () => { const sessionSDK = { useSession: () => input.sdk }; return { ...sessionSDK, currentSessionViewer: () => { const value = sessionSDK.useSession(); return !value || value.isPending || value.error ? undefined : value.data?.user.id ?? null } } })
vi.mock("next/navigation", () => ({ usePathname: () => "/w/test", useRouter: () => ({ refresh: vi.fn(), replace: vi.fn() }), redirect: vi.fn() }))
vi.mock("@/components/authenticated-native-oauth-cleanup", () => ({ AuthenticatedNativeOauthCleanup: () => null }))
vi.mock("@/components/signup-tracker", () => ({ SignupTracker: () => null }))
vi.mock("@/components/signin-tracker", () => ({ SigninTracker: () => null }))
vi.mock("@/components/daemon-update-notice", () => ({ DaemonUpdateNotice: () => null }))
const owners: Record<string, ApplicationOwner> = {}
function Probe() { const owner = useApplicationOwner(); useLayoutEffect(() => { owners[owner.userId] = owner }); return <output>{owner.userId}</output> }
async function layout(id: string) { input.serverId = id; return AppLayout({ children: <Probe /> }) }
beforeEach(async () => { await clearAllPersistedCaches(); input.sdk = { data: { user: { id: "A" } }, isPending: false, error: null } })
afterEach(async () => {
  await act(async () => {
    for (const owner of Object.values(owners)) owner.queryClient.clear(); for (const key of Object.keys(owners)) delete owners[key]
  })
})

describe("actual authenticated AppLayout identity boundary", () => {
  it("retires A when immutable public SDK output and the server layout account change in one commit", async () => {
    const view = render(await layout("A"))
    await waitFor(() => expect(owners.A?.sessionViewer()).toBe("A"))
    const old = owners.A, a = createIdbPersister("A", "application"), b = createIdbPersister("B", "application")
    await act(async () => { await a.restoreClient(); }) ; await act(async () => { await b.restoreClient(); }) ; await act(async () => { await set("alook:qc:v2:A:client", "old A"); }) ; await act(async () => { await set("alook:qc:v2:B:client", "old B") }) ;
    const next = await layout("B")
    act(() => { input.sdk = { data: { user: { id: "B" } }, isPending: false, error: null }; view.rerender(next) })
    await waitFor(() => expect(owners.B?.sessionViewer()).toBe("B"))
    expect(old.lifecycle.get().active).toBe(false)
    await waitFor(async () => expect(await a.isCurrent()).toBe(false))
    expect(await get("alook:qc:v2:A:client")).toBeUndefined()
    expect(await get("alook:qc:v2:B:client")).toBe("old B"); expect(await b.isCurrent()).toBe(true)
    expect(owners.B.lifecycle.get().active).toBe(true)
  })
  it("preserves A disk when the same-viewer layout leaves an ordinary route", async () => {
    const view = render(await layout("A"))
    await waitFor(() => expect(owners.A?.sessionViewer()).toBe("A"))
    const a = createIdbPersister("A", "application"); await act(async () => { await a.restoreClient(); }) ; await act(async () => { await set("alook:qc:v2:A:client", "old A") }) ;
    act(() => view.rerender(<p>Public route</p>))
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(await a.isCurrent()).toBe(true); expect(await get("alook:qc:v2:A:client")).toBe("old A")
  })
})
