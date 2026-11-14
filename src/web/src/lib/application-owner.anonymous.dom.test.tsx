import { BUSINESS_SCHEMA_VERSION, COMMUNITY_CONTRACT_HEADER, CommunityReadErrorSchema } from "@alook/shared"
import "fake-indexeddb/auto"
import { createContext, useContext, useLayoutEffect } from "react"
import { QueryClient, dehydrate } from "@tanstack/react-query"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { act, render, waitFor } from "@/test/react-dom-harness"
import { InviteAcceptClient } from "@/app/(public-community)/c/invite/[token]/invite-accept-client"
import { PublicQueryProvider, useApplicationOwner, type ApplicationOwner } from "./application-owner"
import { CACHE_INVALIDATION_STORAGE_KEY, clearAllPersistedCaches, createIdbPersister, PERSIST_BUSTER, type QualifiedPersister } from "./query-persister"
import { businessSchemaLifecycle, requestDocumentBuildUpdate } from "./business-schema-lifecycle"
import { communityKeys } from "./query-keys"
import { tid } from "@/lib/community/testids"

type Identity = { data: { user: { id: string } } | null; isPending: boolean; error: Error | null }
const identityInput = createContext<Identity>({ data: null, isPending: true, error: null })
let viewer: string | null | undefined
const storage = vi.hoisted(() => ({ writers: [] as QualifiedPersister[] }))
vi.mock("./query-persister", async original => {
  const actual = await original<typeof import("./query-persister")>()
  return { ...actual, createIdbPersister: (id: string | null) => {
    const writer = actual.createIdbPersister(id); storage.writers.push(writer); return writer
  } }
})
vi.mock("@/lib/auth-client", () => ({ useSession: () => useContext(identityInput), currentSessionViewer: () => viewer }))
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), useSearchParams: () => new URLSearchParams() }))

const guest: Identity = { data: null, isPending: false, error: null }
const pending: Identity = { data: null, isPending: true, error: null }
const known = (id: string): Identity => ({ data: { user: { id } }, isPending: false, error: null })
let owner: ApplicationOwner
let reload: ReturnType<typeof vi.fn>
let mounted: ReturnType<typeof render> | undefined
const owners = new Set<ApplicationOwner>()

function Probe() {
  const current = useApplicationOwner()
  useLayoutEffect(() => { owner = current; owners.add(current) })
  return <output>{current.userId}</output>
}
function Root({ identity, invite = false }: { identity: Identity; invite?: boolean }) {
  return <identityInput.Provider value={identity}>
    <PublicQueryProvider><Probe /></PublicQueryProvider>
    {invite && <InviteAcceptClient token="not-a-real-token" />}
  </identityInput.Provider>
}

beforeEach(async () => {
  storage.writers = []
  businessSchemaLifecycle.setState(() => ({ phase: "current", expectedVersion: BUSINESS_SCHEMA_VERSION }))
  await act(async () => { await clearAllPersistedCaches() })
  viewer = undefined
  reload = vi.fn()
  const real = window
  vi.stubGlobal("window", new Proxy(real, { get(target, key) { return key === "location" ? { origin: "https://alook.test", reload } : Reflect.get(target, key, target) } }))
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    expect(url).toBe("/api/community/invites/not-a-real-token/info")
    return Response.json(CommunityReadErrorSchema.parse({ contractVersion: BUSINESS_SCHEMA_VERSION, error: { code: "not_found", message: "Invite not found", retryable: false } }), { status: 404, headers: { [COMMUNITY_CONTRACT_HEADER]: String(BUSINESS_SCHEMA_VERSION) } })
  }))
})

it.each([false, true])("keeps compatible native public-owner data while real account invalidation remains authoritative=%s", async invalidate => {
  viewer = "A"
  mounted = render(<Root identity={known("A")} />)
  await waitFor(() => expect(owner.userId).toBe("A"))
  const originalOwner = owner, writer = storage.writers[0]!, seed = new QueryClient()
  seed.setQueryData(communityKeys.communityDbCollection("A", "profiles"), [{ id: "A", name: "Retained", discriminator: "0042", avatar: null, avatarVersion: 0 }])
  const snapshot = { timestamp: Date.now(), buster: PERSIST_BUSTER, clientState: dehydrate(seed) }
  await writer.persistClient(snapshot)
  const base = window, replace = vi.fn()
  vi.stubGlobal("window", new Proxy(base, { get(target, key) {
    return key === "location" ? { href: "https://alook.test/c/invite/update", origin: "https://alook.test", replace, reload } : Reflect.get(target, key, target)
  } }))
  vi.stubGlobal("navigator", {})
  sessionStorage.clear()
  let queued!: ReturnType<QualifiedPersister["persistClient"]>
  await act(async () => {
    queued = writer.persistClient({ ...snapshot, clientState: { queries: [], mutations: [] } })
    requestDocumentBuildUpdate("next-build")
  })
  await waitFor(() => expect(replace).toHaveBeenCalledOnce())
  expect(originalOwner.lifecycle.get().active).toBe(false)
  if (invalidate) {
    viewer = null
    await act(async () => mounted!.rerender(<Root identity={guest} />))
    await waitFor(async () => expect(await writer.isCurrent()).toBe(false))
  }
  await act(async () => { mounted!.unmount(); mounted = undefined; await queued; await writer.removeClient() })
  const restored = await createIdbPersister("A").restoreClient()
  if (invalidate) expect(restored).toBeUndefined()
  else expect(restored).toEqual(snapshot)
  seed.clear()
})
afterEach(async () => {
  await act(async () => {
    mounted?.unmount(); mounted = undefined
    for (const current of owners) current.queryClient.clear()
    owners.clear()
  })
  vi.unstubAllGlobals()
})

it("settles a cold pending public invitation as guest without retiring shared anonymous leases on transition or unmount", async () => {
  mounted = render(<Root identity={pending} invite />)
  await waitFor(() => expect(owner.userId).toBe("__pending__"))
  const originalOwner = owner
  const anonymous = createIdbPersister(null)
  await act(async () => { await anonymous.restoreClient() })

  viewer = null
  await act(async () => mounted!.rerender(<Root identity={guest} invite />))
  await waitFor(() => expect(owner.userId).toBe("__guest__"))
  await waitFor(() => expect(mounted!.getByTestId(tid.inviteExpiredTitle)).toHaveTextContent("This invite has expired"))
  await act(async () => {
    window.dispatchEvent(new StorageEvent("storage", { key: CACHE_INVALIDATION_STORAGE_KEY }))
    window.dispatchEvent(new Event("pageshow"))
    window.dispatchEvent(new Event("focus"))
    document.dispatchEvent(new Event("visibilitychange"))
    expect(await anonymous.isCurrent()).toBe(true)
  })
  expect(originalOwner.lifecycle.get().active).toBe(false)
  expect(owner.lifecycle.get().active).toBe(true)
  expect(reload).not.toHaveBeenCalled()
  await act(async () => { mounted!.unmount(); mounted = undefined })
  expect(await anonymous.isCurrent()).toBe(true)
  expect(reload).not.toHaveBeenCalled()
})

it("guest to confirmed account leaves the shared anonymous lease current", async () => {
  viewer = null
  mounted = render(<Root identity={guest} />)
  await waitFor(() => expect(owner.userId).toBe("__guest__"))
  const anonymous = createIdbPersister(null)
  await act(async () => { await anonymous.restoreClient() })
  viewer = "A"
  await act(async () => mounted!.rerender(<Root identity={known("A")} />))
  expect(owner.userId).toBe("A")
  expect(owner.lifecycle.get().active).toBe(true)
  expect(await anonymous.isCurrent()).toBe(true)
  expect(reload).not.toHaveBeenCalled()
})

it("ordinary guest unmount preserves another active anonymous owner", async () => {
  viewer = null
  const survivor = render(<Root identity={guest} />)
  const survivingOwner = owner
  try {
    mounted = render(<Root identity={guest} />)
    const anonymous = createIdbPersister(null)
    await act(async () => { await anonymous.restoreClient() })
    await act(async () => { mounted!.unmount(); mounted = undefined })
    await act(async () => {
      window.dispatchEvent(new Event("focus"))
      expect(await anonymous.isCurrent()).toBe(true)
    })
    expect(survivingOwner.lifecycle.get().active).toBe(true)
    expect(reload).not.toHaveBeenCalled()
  } finally { await act(async () => survivor.unmount()) }
})

it("confirmed account to guest still retires the original real account without retiring anonymous leases", async () => {
  viewer = "A"
  mounted = render(<Root identity={known("A")} />)
  await waitFor(() => expect(owner.userId).toBe("A"))
  const account = createIdbPersister("A"), anonymous = createIdbPersister(null)
  await act(async () => { await account.restoreClient(); await anonymous.restoreClient() })
  viewer = null
  await act(async () => mounted!.rerender(<Root identity={guest} />))
  await waitFor(async () => expect(await account.isCurrent()).toBe(false))
  expect(owner.userId).toBe("__guest__")
  expect(owner.lifecycle.get().active).toBe(true)
  expect(await anonymous.isCurrent()).toBe(true)
  expect(reload).not.toHaveBeenCalled()
})

it("explicit device clearing still retires a mounted anonymous owner", async () => {
  viewer = null
  mounted = render(<Root identity={guest} />)
  await waitFor(() => expect(owner.userId).toBe("__guest__"))
  const anonymous = createIdbPersister(null)
  await act(async () => { await anonymous.restoreClient(); await clearAllPersistedCaches() })
  await waitFor(() => expect(owner.lifecycle.get().active).toBe(false))
  expect(await anonymous.isCurrent()).toBe(false)
  expect(reload).toHaveBeenCalledOnce()
})
