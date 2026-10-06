import "fake-indexeddb/auto"
import { createContext, useContext, useLayoutEffect } from "react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { act, render, waitFor } from "@/test/react-dom-harness"
import { InviteAcceptClient } from "@/app/c/invite/[token]/invite-accept-client"
import { PublicQueryProvider, useApplicationOwner, type ApplicationOwner } from "./application-owner"
import { CACHE_INVALIDATION_STORAGE_KEY, clearAllPersistedCaches, createIdbPersister } from "./query-persister"
import { tid } from "@/lib/community/testids"

type Identity = { data: { user: { id: string } } | null; isPending: boolean; error: Error | null }
const identityInput = createContext<Identity>({ data: null, isPending: true, error: null })
let viewer: string | null | undefined
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
  await act(async () => { await clearAllPersistedCaches() })
  viewer = undefined
  reload = vi.fn()
  const real = window
  vi.stubGlobal("window", new Proxy(real, { get(target, key) { return key === "location" ? { origin: "https://alook.test", reload } : Reflect.get(target, key, target) } }))
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    expect(url).toBe("/api/community/invites/not-a-real-token/info")
    return Response.json({ error: "Invite not found" }, { status: 404 })
  }))
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
