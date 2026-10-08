import "fake-indexeddb/auto"
import { useLayoutEffect } from "react"
import { dehydrate, QueryClient, useIsRestoring, useQueryClient } from "@tanstack/react-query"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { act, render, waitFor } from "@/test/react-dom-harness"
import { clearAllPersistedCaches, createIdbPersister, PERSIST_BUSTER } from "@/lib/query-persister"
import { communityKeys } from "@/lib/query-keys"
import { valueEvidence } from "@/lib/observability/data-source"
import { setTelemetryUser } from "@/lib/observability/client"
import { configureTelemetry, installTelemetrySink, retireTelemetry } from "@/lib/observability/telemetry"
import { getCommunityDbRegistry } from "@/lib/community-db/collections"
import { QueryProvider } from "./QueryProvider"

const identity = vi.hoisted(() => ({ id: "account-a" }))
vi.mock("@/lib/auth-client", () => ({ useSession: () => ({ data: { user: { id: identity.id } }, isPending: false, error: null }), currentSessionViewer: () => identity.id }))
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }) }))
vi.mock("@tanstack/react-query-devtools", () => ({ ReactQueryDevtools: () => null }))
const clients = new Map<string, QueryClient>()
const restoring = new Map<string, boolean>()
const events: Array<{ name: string; attributes: Record<string, string> }> = []
let mounted: ReturnType<typeof render> | undefined
const key = (id: string) => communityKeys.communityDbCollection(id, "profiles")
function Probe({ id }: { id: string }) {
  const client = useQueryClient(), pending = useIsRestoring()
  useLayoutEffect(() => { clients.set(id, client); restoring.set(id, pending) }, [id, client, pending])
  return <p>{id}</p>
}
function App({ id }: { id: string }) { return <QueryProvider userId={id}><Probe id={id} /></QueryProvider> }
function activate(id: string) {
  setTelemetryUser(id)
  configureTelemetry({ session_id: "session-" + id }, true)
  installTelemetrySink(event => events.push(event))
}
async function seed(id: string) {
  const client = new QueryClient()
  client.setQueryData(key(id), [{ userId: id, name: "Private " + id, discriminator: "0001", avatar: "A", avatarVersion: 0 }], { updatedAt: Date.now() - 1000 })
  await createIdbPersister(id).persistClient({ timestamp: Date.now(), buster: PERSIST_BUSTER, clientState: dehydrate(client) })
  client.clear()
}
function holdRead(id: string) {
  const original = IDBObjectStore.prototype.get
  let release: (() => void) | undefined
  let held = false
  vi.spyOn(IDBObjectStore.prototype, "get").mockImplementation(function (this: IDBObjectStore, requestKey: IDBValidKey | IDBKeyRange) {
    const request = original.call(this, requestKey)
    if (requestKey === `alook:qc:${PERSIST_BUSTER}:${id}:client` && !held) {
      held = true
      let success: IDBRequest["onsuccess"] = null
      Object.defineProperty(request, "onsuccess", {
        configurable: true,
        get: () => (event: Event) => { release = () => success?.call(request, event) },
        set: (handler: IDBRequest["onsuccess"]) => { success = handler },
      })
    }
    return request
  })
  return { pending: () => typeof release === "function", release: () => { expect(release).toBeTypeOf("function"); release!() } }
}
beforeEach(async () => {
  identity.id = "account-a"; clients.clear(); restoring.clear(); events.length = 0
  document.cookie = "alook_analytics_consent=v1.denied; path=/"
  retireTelemetry()
  await clearAllPersistedCaches()
  await seed("account-a"); await seed("account-b")
  activate("account-a")
})
afterEach(async () => {
  await act(async () => {
    mounted?.unmount(); mounted = undefined
    await new Promise(resolve => setTimeout(resolve, 0))
    for (const client of clients.values()) { await getCommunityDbRegistry(client)?.cleanup(); client.clear() }
    retireTelemetry()
  })
  vi.restoreAllMocks()
})

it("attributes a delayed real IDB snapshot only after the actual Provider hydrates it", async () => {
  const read = holdRead("account-a")
  mounted = render(<App id="account-a" />)
  await waitFor(() => expect(read.pending()).toBe(true))
  const client = clients.get("account-a")!
  expect(restoring.get("account-a")).toBe(true)
  expect(client.getQueryData(key("account-a"))).toBeUndefined()
  expect(events.some(event => event.name === "cache.restore.finish" && event.attributes.phase === "hydrate")).toBe(false)
  await act(async () => read.release())
  await waitFor(() => expect(restoring.get("account-a")).toBe(false))
  expect(client.getQueryData(key("account-a"))).toEqual([expect.objectContaining({ userId: "account-a" })])
  expect(valueEvidence(client, client.getQueryData(key("account-a"))).source).toBe("restored_idb")
  expect(events.filter(event => event.name === "cache.restore.finish").map(event => [event.attributes.phase, event.attributes.outcome])).toEqual([["idb_read", "hit"], ["deserialize", "hit"], ["hydrate", "success"]])
  expect(JSON.stringify(events)).not.toContain("Private")
})

it("the actual retired Provider's delayed IDB callback cannot tag or report into the replacement account", async () => {
  const read = holdRead("account-a")
  mounted = render(<App id="account-a" />)
  await waitFor(() => expect(read.pending()).toBe(true))
  const original = clients.get("account-a")!
  identity.id = "account-b"
  await act(async () => { activate("account-b"); mounted!.rerender(<App id="account-b" />) })
  await waitFor(() => expect(restoring.get("account-b")).toBe(false))
  const replacement = clients.get("account-b")!
  expect(replacement).not.toBe(original)
  const replacementData = replacement.getQueryData(key("account-b"))
  expect(valueEvidence(replacement, replacementData).source).toBe("restored_idb")
  const prior = events.filter(event => event.name.startsWith("cache.restore."))
  const builds = vi.spyOn(original.getQueryCache(), "build")
  const clears = vi.spyOn(original, "clear")
  await act(async () => read.release())
  await waitFor(() => expect(builds).toHaveBeenCalledWith(original, expect.objectContaining({ queryKey: key("account-a") }), expect.any(Object)))
  await waitFor(() => expect(clears).toHaveBeenCalled())
  await waitFor(() => expect(original.getQueryCache().getAll()).toHaveLength(0))
  expect(events.filter(event => event.name.startsWith("cache.restore."))).toEqual(prior)
  expect(replacement.getQueryData(key("account-b"))).toBe(replacementData)
  expect(replacement.getQueryData(key("account-a"))).toBeUndefined()
  expect(valueEvidence(replacement, replacementData).source).toBe("restored_idb")
})

it("regrant during a real Provider restore preserves business hydration without borrowing old telemetry admission", async () => {
  const read = holdRead("account-a")
  mounted = render(<App id="account-a" />)
  await waitFor(() => expect(read.pending()).toBe(true))
  const client = clients.get("account-a")!
  await act(async () => {
    retireTelemetry()
    configureTelemetry({ session_id: "session-regranted" }, true)
    installTelemetrySink(event => events.push(event))
  })
  events.length = 0
  await act(async () => read.release())
  await waitFor(() => expect(restoring.get("account-a")).toBe(false))
  expect(client.getQueryData(key("account-a"))).toEqual([expect.objectContaining({ userId: "account-a" })])
  expect(valueEvidence(client, client.getQueryData(key("account-a"))).source).toBe("unknown")
  expect(events.filter(event => event.name.startsWith("cache.restore."))).toEqual([])
})
