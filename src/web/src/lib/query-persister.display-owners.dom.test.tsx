import "fake-indexeddb/auto"
import { createElement, type PropsWithChildren } from "react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { dehydrate, QueryClient } from "@tanstack/react-query"
import { persistQueryClientRestore, type PersistedClient } from "@tanstack/react-query-persist-client"
import { get } from "idb-keyval"
import { act, render, renderHook, waitFor } from "@/test/react-dom-harness"
import { CommunityTestProvider } from "@/test/community-owner-fixture"
import { channelResourceFixture, fullResourceBundleFixture, messageResourceFixture, profileResourceFixture, serverResourceFixture } from "@/test/community-resource-fixtures"
import { useAutomation } from "@/hooks/community/use-automation"
import { useBilling, type BillingReturn } from "@/hooks/community/use-billing"
import type { AutomationAccessCode, BillingSummary, CommunityReactionDetailsRead } from "@alook/shared"
import { useMessageMarked } from "@/hooks/community/use-inbox"
import { useUnmarkMessage } from "@/hooks/community/mutations/message-memberships"
import { useReactionDetails } from "@/hooks/community/use-reaction-details"
import { removeDmReactionDetails } from "@/hooks/community/community-ws/reaction-details-invalidation"
import PricingClient from "@/app/pricing/pricing-client"
import { createCommunityDbRegistry, type CommunityDbRegistry } from "./community-db/collections"
import { captureCommunityLiveSnapshotToken, discardCommunityRestoreReplacements, publishCommunityResourceBundle, purgeCommunityForumPost, restoreCommunityCollections, retireCommunityChannelReading } from "./community-db/sync"
import { clearAllPersistedCaches, createCommunityRestorePersister, createIdbPersister, PERSIST_BUSTER, PERSIST_MAX_AGE_MS, readCommunityRestoredCollections, shouldDehydrateCommunityQuery } from "./query-persister"
import { accountEpochKey, blobKeyFor } from "./persisted-account-identity"
import { auxiliaryWindowScopeKey } from "./community/auxiliary-window-contract"
import { cacheStore } from "./query-cache-store"
import { communityKeys } from "./query-keys"
import { ApiError } from "./errors"

const mocks = vi.hoisted(() => ({ api: vi.fn(), telemetry: vi.fn(), session: { data: null as { user: { id: string } } | null, isPending: false, error: null },
  beforeApplicationWrite: undefined as ((value: string) => Promise<void> | undefined) | undefined,
  releaseApplicationWrite: undefined as (() => void) | undefined }))
vi.mock("@tanstack/query-async-storage-persister", async original => {
  const actual = await original<typeof import("@tanstack/query-async-storage-persister")>()
  return { ...actual, createAsyncStoragePersister: (options: Parameters<typeof actual.createAsyncStoragePersister>[0]) => {
    const storage = options.storage, beforeWrite = mocks.beforeApplicationWrite
    if (!storage || !beforeWrite) return actual.createAsyncStoragePersister(options)
    return actual.createAsyncStoragePersister({ ...options, storage: { ...storage, setItem: (key, value) => {
      const held = beforeWrite(value)
      return held ? held.then(() => storage.setItem(key, value)) : storage.setItem(key, value)
    } } })
  } }
})
vi.mock("@/lib/api/client", () => ({ apiFetch: mocks.api, toastApiError: vi.fn() }))
vi.mock("@/lib/auth-client", () => ({ useSession: () => mocks.session, currentSessionViewer: () => mocks.session.isPending ? undefined : mocks.session.data?.user.id ?? null }))
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams() }))
vi.mock("@/app/pricing/pricing.module.css", () => ({ default: new Proxy({}, { get: (_target, key) => String(key) }) }))
vi.mock("@/lib/observability/telemetry", async original => ({ ...await original<typeof import("@/lib/observability/telemetry")>(), emitTelemetry: mocks.telemetry }))

const code: AutomationAccessCode = { id: "code", name: "Saved access code", createdAt: "2026-11-01T00:00:00.000Z", expiresAt: null,
  permissions: [{ permission: "machine.read", limit: 1, period: "hour" }] }
const offer: BillingSummary["offers"][number] = { priceId: "price_studio", plan: { id: "studio", displayName: "Studio" }, botLimit: 10, machineLimit: 5, unitAmount: 2000, currency: "usd", interval: "month", intervalCount: 1 }
const free: BillingSummary = { plan: { id: "free", displayName: "Free" }, isFounder: false, offers: [offer], subscription: null }
const catalog = { free: { plan: free.plan, botLimit: 1, machineLimit: 1 }, offers: [offer] }
const registries = new Set<CommunityDbRegistry>(), writers = new Set<ReturnType<typeof createIdbPersister>>()
const hookViews = new Set<ReturnType<typeof mount>>(), publicViews = new Set<ReturnType<typeof render>>()

beforeEach(async () => {
  mocks.beforeApplicationWrite = undefined
  mocks.releaseApplicationWrite = undefined
  await clearAllPersistedCaches()
  mocks.session = { data: null, isPending: false, error: null }
  mocks.api.mockReset()
  mocks.telemetry.mockClear()
})
afterEach(async () => {
  mocks.releaseApplicationWrite?.()
  mocks.beforeApplicationWrite = undefined
  for (const view of hookViews) view.unmount()
  hookViews.clear()
  for (const view of publicViews) view.unmount()
  publicViews.clear()
  for (const writer of writers) writer.stopPersisting()
  writers.clear()
  for (const registry of registries) { await registry.cleanup(); registry.queryClient.clear() }
  registries.clear()
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function backend(empty = false) {
  const state = { unavailable: false, deniedReaction: false, marked: !empty, codes: empty ? [] : [code], commands: [] as string[],
    reactionScope: { kind: "dm", channelId: "dm" } as CommunityReactionDetailsRead["scope"],
    billing: (empty ? { ...free, offers: [] } : free) as BillingSummary,
    heldBilling: undefined as Promise<unknown> | undefined, heldCodes: undefined as Promise<unknown> | undefined,
    heldMarked: undefined as Promise<unknown> | undefined, heldReaction: undefined as Promise<unknown> | undefined }
  mocks.api.mockImplementation(async (path: string, options: { method?: string } = {}) => {
    if (options.method && options.method !== "GET") {
      state.commands.push(`${options.method} ${path}`)
      if (path.endsWith("/marks")) state.marked = options.method === "PUT"
      if (path.includes("/access-codes/") && options.method === "DELETE") state.codes = []
      return undefined
    }
    if (path.endsWith("/marks") && state.heldMarked) { const held = state.heldMarked; state.heldMarked = undefined; return held }
    if (path === "/api/community/automation/access-codes" && state.heldCodes) { const held = state.heldCodes; state.heldCodes = undefined; return held }
    if (path.endsWith("/reactions") && state.heldReaction) { const held = state.heldReaction; state.heldReaction = undefined; return held }
    if (path === "/api/community/billing" && state.heldBilling) { const held = state.heldBilling; state.heldBilling = undefined; return held }
    if (path.endsWith("/reactions") && state.deniedReaction) throw new ApiError("Forbidden", 403)
    if (state.unavailable) throw new ApiError("offline", 503)
    if (path === "/api/pricing") return catalog
    if (path === "/api/community/billing") return state.billing
    if (path === "/api/community/automation/access-codes") return { accessCodes: state.codes, secret: "synthetic-creation-secret-must-not-survive" }
    if (path.endsWith("/marks")) return { marked: state.marked }
    if (path.endsWith("/reactions")) return { messageId: "message", scope: state.reactionScope, actors: empty ? [] : [
      { userId: "actor", profile: { id: "actor", name: "Saved actor", discriminator: "0042", avatar: null, avatarVersion: 0 } },
      { userId: "redacted", profile: null },
    ] }
    throw new Error(`Unexpected display request ${path}`)
  })
  return state
}

function newOwner(account: string, waitForRestore?: Promise<void>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } } })
  const registry = createCommunityDbRegistry(client, account, { waitForRestore })
  const writer = createIdbPersister(account)
  registry.bindAuthentication(() => account, writer.retireAccount, writer.retireChannels, writer.retireAuxiliaryScopes, writer.captureAuxiliaryReadEpoch)
  registries.add(registry); writers.add(writer)
  return { account, client, registry, writer }
}
type Owner = ReturnType<typeof newOwner>
async function seed(forum = false) {
  const owner = newOwner(`display-${crypto.randomUUID()}`)
  await owner.registry.preload()
  const resources = fullResourceBundleFixture(owner.account, forum ? [serverResourceFixture({ id: "server", ownerId: owner.account })] : [],
    forum ? [channelResourceFixture({ id: "forum", type: "forum", serverId: "server" }),
      channelResourceFixture({ id: "child", type: "thread", serverId: "server", parentChannelId: "forum", parentMessageId: "message" })]
      : [channelResourceFixture({ id: "dm", type: "dm", serverId: null })], [messageResourceFixture({ id: "message", channelId: forum ? "forum" : "dm" })])
  resources.profiles.push(profileResourceFixture({ id: "redacted", name: "Do not borrow" }))
  await publishCommunityResourceBundle(owner.client, resources, { token: captureCommunityLiveSnapshotToken(owner.client) })
  return owner
}
function mount(owner: Owner, billingReturn: BillingReturn = null) {
  const wrapper = ({ children }: PropsWithChildren) => createElement(CommunityTestProvider, { client: owner.client, registry: owner.registry, userId: owner.account, retainOwner: true }, children)
  const view = renderHook(() => ({ codes: useAutomation(owner.account), billing: useBilling(billingReturn, true), marked: useMessageMarked("message", true),
    reactions: useReactionDetails({ messageId: "message", open: true, userIds: [] }), unmark: useUnmarkMessage() }), { wrapper })
  hookViews.add(view)
  return view
}
async function save(owner: Owner) {
  const previous = await get<string>(blobKeyFor(owner.account), cacheStore)
  const timestamp = Math.max(Date.now(), previous ? JSON.parse(previous).timestamp + 1 : 0)
  await owner.writer.persistClient({ timestamp, buster: PERSIST_BUSTER, clientState: dehydrate(owner.client, { shouldDehydrateQuery: shouldDehydrateCommunityQuery }) })
  const committed = JSON.parse((await get<string>(blobKeyFor(owner.account), cacheStore))!)
  expect(committed.timestamp).toBe(timestamp)
  return committed
}
async function replace(owner: Owner, view: ReturnType<typeof mount>) {
  view.unmount(); hookViews.delete(view)
  owner.writer.stopPersisting()
  await owner.registry.cleanup(); owner.client.clear(); registries.delete(owner.registry)
  let release!: () => void
  const next = newOwner(owner.account, new Promise<void>(resolve => { release = resolve }))
  const restore = createCommunityRestorePersister(next.writer, owner.account)
  await persistQueryClientRestore({ queryClient: next.client, persister: restore.persister, buster: PERSIST_BUSTER, maxAge: PERSIST_MAX_AGE_MS })
  const input = restore.takeCollections()
  try { await restoreCommunityCollections(next.registry, input); next.registry.captureRestoredCollections(input); next.registry.runtime.ws.actions.activateProfileAccount(owner.account) }
  finally { discardCommunityRestoreReplacements(next.registry); release() }
  await next.registry.preload()
  return next
}
async function loaded(view: ReturnType<typeof mount>) {
  await waitFor(() => {
    expect(view.result.current.codes.list.isSuccess).toBe(true)
    expect(view.result.current.billing.isSuccess).toBe(true)
    expect(view.result.current.marked.isSuccess).toBe(true)
    expect(view.result.current.reactions.isSuccess).toBe(true)
  })
}
async function failed(view: ReturnType<typeof mount>) {
  await waitFor(() => {
    expect(view.result.current.codes.list.isError).toBe(true)
    expect(view.result.current.billing.isError).toBe(true)
    expect(view.result.current.marked.isError).toBe(true)
    expect(view.result.current.reactions.isError).toBe(true)
  })
}

it.each([false, true])("retains the four actual community hook reads through failed refresh, second commit and a third owner; empty=%s", async empty => {
  const state = backend(empty)
  let owner = await seed(), view = mount(owner)
  await loaded(view)
  const first = await save(owner)
  expect(JSON.stringify(first)).not.toContain("synthetic-creation-secret")
  const queryTimes = new Map(first.clientState.queries.map((query: { queryHash: string; state: { dataUpdatedAt: number } }) => [query.queryHash, query.state.dataUpdatedAt]))
  state.unavailable = true
  for (let generation = 0; generation < 2; generation++) {
    owner = await replace(owner, view); view = mount(owner)
    await failed(view)
    expect(view.result.current.codes.list.data?.accessCodes).toEqual(empty ? [] : [code])
    expect(view.result.current.billing.data).toEqual(empty ? { ...free, offers: [] } : free)
    expect(view.result.current.marked.data?.marked).toBe(!empty)
    expect(view.result.current.reactions.data?.actors.map(actor => actor.userId)).toEqual(empty ? [] : ["actor", "redacted"])
    if (!empty) {
      expect(view.result.current.reactions.data?.actors[0].profile?.name).toBe("Saved actor")
      expect(view.result.current.reactions.data?.actors[1].profile).toBeNull()
    }
    expect(view.result.current.billing.isCurrentRead()).toBe(false)
    expect(view.result.current.codes.isCurrentRead()).toBe(false)
    await act(async () => {
      await view.result.current.billing.checkout(offer.priceId, false, "billing_sheet")
      if (!empty) await expect(view.result.current.codes.execute({ kind: "delete", id: code.id })).rejects.toMatchObject({ name: "AbortError" })
    })
    expect(state.commands).toEqual([])
    const saved = await save(owner)
    for (const query of saved.clientState.queries) if (queryTimes.has(query.queryHash)) expect(query.state.dataUpdatedAt).toBe(queryTimes.get(query.queryHash))
  }
})

it("allows personal Unmark after channel access is retired and fences its earlier true snapshot", async () => {
  const state = backend(), original = await seed()
  let view = mount(original)
  await loaded(view)
  const before = await save(original)
  state.unavailable = true
  const owner = await replace(original, view); view = mount(owner)
  await failed(view)
  let release!: (value: unknown) => void, pending!: ReturnType<typeof view.result.current.marked.refetch>
  state.heldMarked = new Promise(resolve => { release = resolve })
  act(() => { pending = view.result.current.marked.refetch() })
  await waitFor(() => expect(view.result.current.marked.isFetching).toBe(true))
  await waitFor(() => expect(state.heldMarked).toBeUndefined())
  act(() => { retireCommunityChannelReading(owner.registry, "dm", { reason: "read-denied" }) })
  await act(async () => { await view.result.current.unmark.mutateAsync({ messageId: "message" }) })
  await act(async () => { release({ marked: true }); await pending })
  expect(state.commands).toEqual(["DELETE /api/community/messages/message/marks"])
  expect(view.result.current.marked.data?.marked).toBe(false)
  await owner.writer.persistClient(before)
  await save(owner)
  const next = await replace(owner, view)
  const restored = mount(next)
  await waitFor(() => expect(restored.result.current.marked.isError).toBe(true))
  expect(restored.result.current.marked.data?.marked).toBe(false)
})

it("keeps a confirmed code deletion through a held list reply, queued old save and cold refresh failure", async () => {
  const state = backend(), owner = await seed(), view = mount(owner)
  await loaded(view)
  const before = await save(owner)
  let release!: (value: unknown) => void, pending!: ReturnType<typeof view.result.current.codes.list.refetch>
  state.heldCodes = new Promise(resolve => { release = resolve })
  act(() => { pending = view.result.current.codes.list.refetch() })
  await waitFor(() => expect(view.result.current.codes.list.isFetching).toBe(true))
  await waitFor(() => expect(state.heldCodes).toBeUndefined())
  state.unavailable = true
  await act(async () => { await view.result.current.codes.execute({ kind: "delete", id: code.id }) })
  await waitFor(() => expect(view.result.current.codes.list.data?.accessCodes).toEqual([]))
  await act(async () => { release({ accessCodes: [code] }); await pending })
  expect(view.result.current.codes.list.data?.accessCodes).toEqual([])
  expect(state.commands).toEqual(["DELETE /api/community/automation/access-codes/code"])
  await owner.writer.persistClient(before)
  await save(owner)
  const next = await replace(owner, view), restored = mount(next)
  await failed(restored)
  expect(restored.result.current.codes.list.data?.accessCodes).toEqual([])
})

it("removes reaction display and rejects a held response and earlier disk snapshot after DM revocation", async () => {
  const state = backend(), owner = await seed(), view = mount(owner)
  await loaded(view)
  const before = await save(owner)
  let release!: (value: unknown) => void
  state.heldReaction = new Promise(resolve => { release = resolve })
  let pending!: ReturnType<typeof view.result.current.reactions.refetch>
  act(() => { pending = view.result.current.reactions.refetch() })
  await waitFor(() => expect(view.result.current.reactions.isFetching).toBe(true))
  await waitFor(() => expect(state.heldReaction).toBeUndefined())
  state.unavailable = true
  act(() => removeDmReactionDetails(owner.client))
  await act(async () => {
    release({ messageId: "message", scope: { kind: "dm", channelId: "dm" }, actors: [{ userId: "actor", profile: { id: "actor", name: "Late actor", discriminator: "0042", avatar: null, avatarVersion: 0 } }] })
    await pending
  })
  await owner.writer.persistClient(before)
  expect((await owner.writer.restoreClient())?.clientState.queries.some(query => query.queryKey[1] === "reaction-details")).toBe(false)
  expect(owner.registry.collections.profiles.get("actor")?.name).toBe("Saved actor")
})

it("recomputes code expiry after cold restore without treating an unavailable read as fresh empty", async () => {
  vi.useFakeTimers({ toFake: ["Date"] })
  const now = Date.parse("2026-11-18T11:00:00.000Z")
  vi.setSystemTime(now)
  const state = backend(), owner = await seed()
  state.codes = [{ ...code, expiresAt: new Date(now + 60_000).toISOString() }]
  const view = mount(owner)
  await loaded(view)
  await save(owner)
  state.unavailable = true
  vi.setSystemTime(now + 120_000)
  const next = await replace(owner, view), restored = mount(next)
  await failed(restored)
  expect(restored.result.current.codes.list.data?.accessCodes).toEqual([])
  expect(next.client.getQueryData<{ accessCodes: AutomationAccessCode[] }>(["community", "automation-access-codes", next.account])?.accessCodes).toHaveLength(1)
  expect(restored.result.current.codes.isCurrentRead()).toBe(false)
  await save(next)
  const third = await replace(next, restored), again = mount(third)
  await failed(again)
  expect(again.result.current.codes.list.data?.accessCodes).toEqual([])
})

it("keeps an oversized live code response whole and restores it as unknown when it cannot fit", async () => {
  const state = backend(), owner = await seed()
  state.codes = Array.from({ length: 401 }, (_, index) => ({ ...code, id: `large-${index}` }))
  const view = mount(owner)
  await loaded(view)
  expect(view.result.current.codes.list.data?.accessCodes).toHaveLength(401)
  const stored = await save(owner)
  expect(stored.clientState.queries.some((query: { queryKey: unknown[] }) => query.queryKey[1] === "automation-access-codes")).toBe(false)
  state.unavailable = true
  const next = await replace(owner, view), restored = mount(next)
  await failed(restored)
  expect(restored.result.current.codes.list.data).toBeUndefined()
})

it("withdraws denied reaction details without deleting the message or personal Marked state and permits a later granted read", async () => {
  const state = backend(), owner = await seed(), view = mount(owner)
  await loaded(view)
  await save(owner)
  state.deniedReaction = true
  await act(async () => { await view.result.current.reactions.refetch() })
  await waitFor(() => expect(view.result.current.reactions.isError).toBe(true))
  expect(view.result.current.reactions.data).toBeUndefined()
  expect(owner.registry.collections.messages.has("message")).toBe(true)
  expect(view.result.current.marked.data?.marked).toBe(true)
  expect(mocks.api.mock.calls.filter(([path]) => path.endsWith("/reactions"))).toHaveLength(2)
  await save(owner)
  state.deniedReaction = false
  await act(async () => { await view.result.current.reactions.refetch() })
  await waitFor(() => expect(view.result.current.reactions.data?.actors[0].profile?.name).toBe("Saved actor"))
  await save(owner)
  state.unavailable = true
  const next = await replace(owner, view), restored = mount(next)
  await failed(restored)
  expect(restored.result.current.reactions.data?.actors[0].profile?.name).toBe("Saved actor")
  expect(restored.result.current.marked.data?.marked).toBe(true)
})

it.each([false, true])("permanently retires a deleted forum opener, its display and held reads; prior known=%s", async known => {
  const state = backend(), owner = await seed(true)
  state.reactionScope = { kind: "server", serverId: "server", channelId: "forum" }
  let view: ReturnType<typeof mount>
  let before: Awaited<ReturnType<typeof save>>
  if (known) { view = mount(owner); await loaded(view); before = await save(owner) }
  else before = await save(owner)
  let releaseMarked!: (value: unknown) => void, releaseReaction!: (value: unknown) => void
  const markedRead = new Promise(resolve => { releaseMarked = resolve }), reactionRead = new Promise(resolve => { releaseReaction = resolve })
  state.heldMarked = markedRead; state.heldReaction = reactionRead
  if (known) act(() => { void view!.result.current.marked.refetch(); void view!.result.current.reactions.refetch() })
  else view = mount(owner)
  await waitFor(() => { expect(state.heldMarked).toBeUndefined(); expect(state.heldReaction).toBeUndefined() })
  state.unavailable = true
  act(() => purgeCommunityForumPost(owner.registry, { childChannelId: "child", openerMessageId: "message", serverId: "server" }))
  expect(owner.registry.collections.messages.get("message")).toBeUndefined()
  await act(async () => {
    releaseMarked({ marked: true })
    releaseReaction({ messageId: "message", scope: state.reactionScope, actors: [{ userId: "actor", profile: { id: "actor", name: "Deleted late actor", discriminator: "0042", avatar: null, avatarVersion: 0 } }] })
    await Promise.all([markedRead, reactionRead])
  })
  await waitFor(async () => {
    const fences = await get<Map<string, { deleted: boolean }>>(`${accountEpochKey(owner.account)}:channels`, cacheStore)
    expect(fences?.get(auxiliaryWindowScopeKey({ kind: "message", id: "message" }))?.deleted).toBe(true)
  })
  await owner.writer.persistClient(before)
  const restored = await owner.writer.restoreClient()
  expect(restored?.clientState.queries.some(query => query.queryKey[1] === "reaction-details" || query.queryKey[1] === "message" && query.queryKey[3] === "marked")).toBe(false)
  expect(readCommunityRestoredCollections(restored, owner.account).messages?.rows.some(message => message.id === "message")).not.toBe(true)
  expect(owner.registry.collections.profiles.get("actor")?.name).not.toBe("Deleted late actor")
})

it.each([false, true])("keeps optional disk-read capture from blocking the four original GETs, actual IDB fault=%s", async failCapture => {
  backend()
  const owner = await seed()
  expect(await owner.writer.isCurrent()).toBe(true)
  await owner.registry.retireAuxiliaryDisk([{ kind: "message-marked", id: "unrelated" }])
  const epoch = await owner.registry.captureAuxiliaryReadEpoch()
  expect(epoch).toEqual(expect.any(String))
  let faults = 0
  if (failCapture) {
    const original = IDBDatabase.prototype.transaction
    vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function (this: IDBDatabase, ...args: Parameters<typeof original>) {
      if (args[1] === "readonly") { faults++; throw new DOMException("Optional read qualification unavailable", "UnknownError") }
      return original.apply(this, args)
    })
  }
  const view = mount(owner)
  await loaded(view)
  expect(mocks.api.mock.calls.filter(([, options]) => !options?.method || options.method === "GET")).toHaveLength(4)
  expect(faults).toBe(failCapture ? 3 : 0)
  for (const key of [["community", "automation-access-codes", owner.account], communityKeys.messageMarked("message"), communityKeys.reactionDetails("message")])
    expect(owner.client.getQueryData<{ auxiliaryReadEpoch?: string }>(key)?.auxiliaryReadEpoch).toBe(failCapture ? undefined : epoch)
})

it("requires an actual post-return billing read even when the restored success has the same clock", async () => {
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(new Date("2026-11-18T10:00:00.000Z"))
  const state = backend()
  state.billing = { ...free, plan: offer.plan, subscription: { plan: offer.plan, status: "active", currentPeriodEnd: null, cancelAt: null, scheduledChange: null } }
  const original = await seed(), first = mount(original)
  await loaded(first)
  await save(original)
  const owner = await replace(original, first)
  let release!: (value: unknown) => void
  state.heldBilling = new Promise(resolve => { release = resolve })
  const view = mount(owner, "checkout")
  const successes = () => mocks.telemetry.mock.calls.filter(([, fields]) => fields?.action_name === "billing_return" && fields?.outcome === "success")
  await waitFor(() => expect(view.result.current.billing.data?.plan.id).toBe("studio"))
  expect(view.result.current.billing.isCurrentRead()).toBe(false)
  expect(successes()).toHaveLength(0)
  expect(state.commands).toEqual([])
  await act(async () => { release(state.billing) })
  await waitFor(() => expect(view.result.current.billing.isCurrentRead()).toBe(true))
  await waitFor(() => expect(successes()).toHaveLength(1))
  expect(view.result.current.billing.polling).toBe(false)
})

it("uses the actual public Pricing provider writer and cold restore without overwriting community or enabling payment", async () => {
  const state = backend(), account = `pricing-${crypto.randomUUID()}`
  mocks.session = { data: { user: { id: account } }, isPending: false, error: null }
  const community = new QueryClient(), communityWriter = createIdbPersister(account)
  writers.add(communityWriter)
  community.setQueryData(communityKeys.communityDbCollection(account, "profiles"), [profileResourceFixture({ id: account })])
  await communityWriter.persistClient({ timestamp: Date.now(), buster: PERSIST_BUSTER, clientState: dehydrate(community) })
  community.clear()
  let page = render(<PricingClient />); publicViews.add(page)
  await waitFor(() => expect(page.getByRole("button", { name: "Choose Studio" })).toBeEnabled())
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 1000)) })
  let first!: string
  await waitFor(async () => {
    first = (await get<string>(blobKeyFor(account, "application"), cacheStore))!
    const queries = JSON.parse(first).clientState.queries
    expect(queries.some((query: { queryKey: unknown[] }) => query.queryKey[0] === "public-pricing")).toBe(true)
    expect(queries.some((query: { queryKey: unknown[] }) => query.queryKey[0] === "application")).toBe(true)
  })
  expect((await createIdbPersister(account).restoreClient())?.clientState.queries.some(query => query.queryKey[3] === "profiles")).toBe(true)
  state.unavailable = true
  let committedAt = JSON.parse(first).timestamp
  for (let generation = 0; generation < 2; generation++) {
    page.unmount(); publicViews.delete(page)
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    page = render(<PricingClient />); publicViews.add(page)
    await waitFor(() => expect(page.getByText("Couldn't load plans. Try again before choosing a plan.")).toBeInTheDocument())
    expect(page.getByRole("button", { name: "Choose Studio" })).toBeDisabled()
    expect(state.commands).toEqual([])
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 1000)) })
    await waitFor(async () => {
      const saved = JSON.parse((await get<string>(blobKeyFor(account, "application"), cacheStore))!)
      expect(saved.timestamp).toBeGreaterThan(committedAt)
      expect(saved.clientState.queries).toHaveLength(2)
      for (const query of saved.clientState.queries) expect(query.state.dataUpdatedAt).toBe(JSON.parse(first).clientState.queries.find((old: { queryHash: string }) => old.queryHash === query.queryHash).state.dataUpdatedAt)
      committedAt = saved.timestamp
    })
  }
})

function applicationSnapshotCommit(account: string) {
  const key = blobKeyFor(account, "application"), original = IDBObjectStore.prototype.put
  return new Promise<void>(resolve => {
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args: Parameters<typeof original>) {
      const request = original.apply(this, args)
      if (args[1] === key && typeof args[0] === "string") {
        const snapshot = JSON.parse(args[0]) as PersistedClient
        if (snapshot.clientState.queries.length === 2
          && snapshot.clientState.queries.some(query => query.queryKey.length === 1 && query.queryKey[0] === "public-pricing")
          && snapshot.clientState.queries.some(query => query.queryKey.length === 3 && query.queryKey[0] === "application" && query.queryKey[1] === account && query.queryKey[2] === "billing"))
          this.transaction.addEventListener("complete", () => resolve(), { once: true })
      }
      return request
    })
  })
}

async function verifyPublicProviderAccountSwitch(onReady?: (account: string) => void) {
  const state = backend(), account = `old-pricing-${crypto.randomUUID()}`
  state.billing = { ...free, plan: { id: "private-plan", displayName: "Private account A plan" } }
  mocks.session = { data: { user: { id: account } }, isPending: false, error: null }
  const source = new QueryClient(), communityWriter = createIdbPersister(account)
  writers.add(communityWriter)
  source.setQueryData(communityKeys.communityDbCollection(account, "profiles"), [profileResourceFixture({ id: account })])
  await communityWriter.persistClient({ timestamp: Date.now(), buster: PERSIST_BUSTER, clientState: dehydrate(source) })
  source.clear()
  const committed = applicationSnapshotCommit(account)
  const page = render(<PricingClient />); publicViews.add(page)
  await waitFor(() => expect(page.getByText("Your current plan: Private account A plan.")).toBeInTheDocument())
  onReady?.(account)
  await committed
  expect(JSON.parse((await get<string>(blobKeyFor(account, "application"), cacheStore))!).clientState.queries).toHaveLength(2)
  state.unavailable = true
  mocks.session = { data: { user: { id: "next-account" } }, isPending: false, error: null }
  page.rerender(<PricingClient />)
  await waitFor(() => expect(page.getByText("Couldn't load plans. Try again before choosing a plan.")).toBeInTheDocument())
  expect(page.queryByText("Your current plan: Private account A plan.")).not.toBeInTheDocument()
  await waitFor(async () => {
    expect(await get(blobKeyFor(account), cacheStore)).toBeUndefined()
    expect(await get(blobKeyFor(account, "application"), cacheStore)).toBeUndefined()
    expect(await communityWriter.isCurrent()).toBe(false)
  })
  expect(state.commands).toEqual([])
}

it("retires both old account payloads during the actual public provider account switch", async () => {
  await verifyPublicProviderAccountSwitch()
})

it("keeps the account-switch fixture pending while its two-query application write is held", async () => {
  let release!: () => void, ready!: (account: string) => void, blocked!: (account: string) => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const mounted = new Promise<string>(resolve => { ready = resolve })
  const pending = new Promise<string>(resolve => { blocked = resolve })
  mocks.releaseApplicationWrite = release
  mocks.beforeApplicationWrite = value => {
    const queries = (JSON.parse(value) as PersistedClient).clientState.queries
    const billing = queries.find(query => query.queryKey[0] === "application" && query.queryKey[2] === "billing")
    const account = billing?.queryKey[1]
    if (queries.length === 2 && typeof account === "string" && queries.some(query => query.queryKey[0] === "public-pricing")) {
      blocked(account)
      return gate
    }
  }
  let settled = false
  const completed = verifyPublicProviderAccountSwitch(ready).then(() => { settled = true }, error => { settled = true; throw error })
  void completed.catch(() => undefined)
  try {
    const account = await mounted
    await new Promise(resolve => setTimeout(resolve, 1000))
    expect(await pending).toBe(account)
    const raw = await get<string>(blobKeyFor(account, "application"), cacheStore)
    expect(raw ? (JSON.parse(raw) as PersistedClient).clientState.queries.length : 0).toBeLessThan(2)
    expect(settled).toBe(false)
    expect(mocks.session.data?.user.id).toBe(account)
  } finally {
    release()
    await completed
  }
})
