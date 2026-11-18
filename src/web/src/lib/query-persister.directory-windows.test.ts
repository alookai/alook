import "fake-indexeddb/auto"
import { afterEach, describe, expect, it, vi } from "vitest"
import { dehydrate, QueryClient } from "@tanstack/react-query"
import { persistQueryClientRestore } from "@tanstack/react-query-persist-client"
import { get } from "idb-keyval"
import { membersPageQueryFn } from "@/hooks/community/use-server-members"
import { invitesQueryFn } from "@/hooks/community/use-server-panels"
import { channelResourceFixture, fullResourceBundleFixture, invitesReadFixture, profileResourceFixture, serverResourceFixture } from "@/test/community-resource-fixtures"
import { createCommunityDbRegistry, type CommunityDbRegistry } from "./community-db/collections"
import { captureCommunityLiveSnapshotToken, completeCommunityPublication, discardCommunityRestoreReplacements, publishCommunityResourceBundle, purgeCommunityServer, restoreCommunityCollections } from "./community-db/sync"
import { serverMembershipKey } from "./community-db/schema"
import { communityKeys } from "./query-keys"
import { cacheStore } from "./query-cache-store"
import { searchCommunityUsers } from "./community/user-search"
import { AUXILIARY_READ_EPOCH_KEY, auxiliaryWindowScopeKey } from "./community/auxiliary-window-contract"
import { blobKeyFor } from "./persisted-account-identity"
import { directoryWindowComplete, directoryWindowRetiredKeys, readDirectoryWindow } from "./community/directory-window-persistence"
import { clearPersistedCache, createCommunityRestorePersister, createIdbPersister, PERSIST_BUSTER, PERSIST_MAX_AGE_MS, shouldDehydrateCommunityQuery } from "./query-persister"

const api = vi.hoisted(() => vi.fn())
vi.mock("@/lib/api/client", () => ({ apiFetch: api, toastApiError: vi.fn() }))
const owners = new Set<CommunityDbRegistry>()
const accounts = new Set<string>()
const persisters: ReturnType<typeof createIdbPersister>[] = []
const rosterKey = communityKeys.members("server")

afterEach(async () => {
  for (const persister of persisters.splice(0)) persister.stopPersisting()
  for (const registry of owners) { await registry.cleanup(); registry.queryClient.clear() }
  owners.clear()
  for (const account of accounts) await clearPersistedCache(account)
  accounts.clear()
  api.mockReset()
})

async function seed(empty: boolean) {
  const account = `directory-${crypto.randomUUID()}`
  accounts.add(account)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const registry = createCommunityDbRegistry(client, account)
  owners.add(registry)
  await registry.preload()
  await publishCommunityResourceBundle(client, fullResourceBundleFixture(account,
    [serverResourceFixture({ id: "server", ownerId: account })], [], [], [profileResourceFixture({ id: account })]),
  { token: captureCommunityLiveSnapshotToken(client) })
  api.mockResolvedValue({ viewerId: account, serverId: "server", hasMore: false, limit: 100, total: empty ? 0 : 1,
    members: empty ? [] : [{ id: "member-peer", userId: "peer", name: "Saved peer", discriminator: "0042", avatar: "P", avatarVersion: 0,
      role: "member", status: "offline", sub: "", statusEmoji: null, statusText: "" }],
  })
  await client.infiniteQuery({ queryKey: rosterKey, queryFn: membersPageQueryFn("server"), initialPageParam: null })
  expect(api).toHaveBeenCalledTimes(1)
  return { account, client, registry }
}

type Owner = Awaited<ReturnType<typeof seed>>

async function saveAndRestore(source: Owner) {
  const writer = createIdbPersister(source.account)
  persisters.push(writer)
  const before = await get<string>(blobKeyFor(source.account), cacheStore)
  const timestamp = Math.max(Date.now(), before ? JSON.parse(before).timestamp + 1 : 0)
  await writer.persistClient({ timestamp, buster: PERSIST_BUSTER, clientState: dehydrate(source.client, { shouldDehydrateQuery: shouldDehydrateCommunityQuery }) })
  const raw = await get<string>(blobKeyFor(source.account), cacheStore)
  expect(JSON.parse(raw!).timestamp).toBe(timestamp)
  writer.stopPersisting()
  return restoreSavedOwner(source)
}

async function restoreSavedOwner(source: Owner) {
  await source.registry.cleanup()
  owners.delete(source.registry)
  source.client.clear()
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  let release!: () => void
  const registry = createCommunityDbRegistry(client, source.account, { waitForRestore: new Promise<void>(resolve => { release = resolve }) })
  owners.add(registry)
  const reader = createIdbPersister(source.account)
  persisters.push(reader)
  const restore = createCommunityRestorePersister(reader, source.account)
  await persistQueryClientRestore({ queryClient: client, persister: restore.persister, buster: PERSIST_BUSTER, maxAge: PERSIST_MAX_AGE_MS })
  const input = restore.takeCollections()
  try { await restoreCommunityCollections(registry, input); registry.captureRestoredCollections(input); registry.runtime.ws.actions.activateProfileAccount(source.account) }
  finally { discardCommunityRestoreReplacements(registry); release() }
  await registry.preload()
  return { account: source.account, client, registry }
}

describe("directory windows through real IDB and new canonical owners", () => {
  it("keeps old page and physical-parent fences when another page has a fresh auxiliary proof", () => {
    const oldEpoch = crypto.randomUUID(), epoch = crypto.randomUUID()
    const serverKey = auxiliaryWindowScopeKey({ kind: "server", id: "server" })
    const retired = new Map([[serverKey, { epoch: crypto.randomUUID() }], [AUXILIARY_READ_EPOCH_KEY, { epoch }], ["parent", { epoch: crypto.randomUUID() }]])
    const page = (auxiliaryReadEpoch: string, cursor: string) => ({ members: [], hasMore: true, cursor, limit: 100, total: 0, liveRevision: 0, observed: true, auxiliaryReadEpoch })
    const read = (first: string) => readDirectoryWindow(rosterKey, { pages: [page(first, "after-first"), page(epoch, "after-second")], pageParams: [null, "after-first"] })!
    expect(directoryWindowRetiredKeys(read(oldEpoch), retired).has(serverKey)).toBe(true)
    expect(directoryWindowRetiredKeys(read(epoch), retired).has(serverKey)).toBe(false)
    expect(directoryWindowRetiredKeys(read(epoch), retired).has("parent")).toBe(true)
  })

  it("retains whole roster pages, their real continuation, and the latest total at the row limit", () => {
    const page = (offset: number, total: number) => ({ members: Array.from({ length: 100 }, (_, index) => ({ id: `member-${offset + index}`, userId: `person-${offset + index}` })), hasMore: true, cursor: `after-${offset + 100}`, limit: 100, total, liveRevision: 0, observed: true })
    const pages = Array.from({ length: 5 }, (_, index) => page(index * 100, 600 + index))
    const window = readDirectoryWindow(rosterKey, { pages, pageParams: [null, ...pages.slice(0, -1).map(row => row.cursor)] })
    expect(window?.kind).toBe("members")
    if (window?.kind !== "members") throw new Error("Missing roster window")
    expect(window.data.pages.map(row => row.members.length)).toEqual([100, 100, 100, 100])
    expect(window.data.pageParams).toEqual([null, "after-100", "after-200", "after-300"])
    expect(window.data.pages.at(-1)).toMatchObject({ hasMore: true, cursor: "after-400", total: 604, observed: false })
    expect(readDirectoryWindow(rosterKey, { pages, pageParams: [null, "wrong", "after-200", "after-300", "after-400"] })).toBeUndefined()
  })

  it("refuses a known-empty thread roster when its parent access dependency is missing", () => {
    const window = readDirectoryWindow(communityKeys.channelMembers("thread", "notify"), { serverId: "server", relation: "notify", members: [], creatorIds: [], observed: true })!
    const rows = { servers: [serverResourceFixture({ id: "server", ownerId: "viewer" })], channels: [
      { ...channelResourceFixture({ id: "parent", serverId: "server", type: "text", parentChannelId: null }), pending: false, muted: false, tags: [] },
      { ...channelResourceFixture({ id: "thread", serverId: "server", type: "thread", parentChannelId: "parent" }), pending: false, muted: false, tags: [] },
    ], serverMemberships: [{ id: "server:viewer", serverId: "server", userId: "viewer", memberId: "viewer-member", viewer: true, role: "owner" }],
    channelMemberships: [{ id: "thread:viewer:access", channelId: "thread", userId: "viewer", relation: "access" as const, source: "explicit" as const }], profiles: [] }
    expect(directoryWindowComplete(window, rows as Parameters<typeof directoryWindowComplete>[1], "viewer")).toBe(false)
    rows.channelMemberships.push({ id: "parent:viewer:access", channelId: "parent", userId: "viewer", relation: "access" as const, source: "explicit" as const })
    expect(directoryWindowComplete(window, rows as Parameters<typeof directoryWindowComplete>[1], "viewer")).toBe(true)
    expect(directoryWindowComplete(window, rows as Parameters<typeof directoryWindowComplete>[1], "viewer", new Set(["parent"]))).toBe(false)
  })

  it("uses one twenty-window budget across roster and exact user searches", async () => {
    const source = await seed(false)
    let now = Date.now() + 1
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now)
    try {
      api.mockImplementation(async (path: string) => {
        const query = new URL(path, "https://fixture.test").searchParams.get("q")!
        return { users: [{ id: query, name: query, discriminator: "0042", image: null, avatarVersion: 0 }] }
      })
      const terms = Array.from({ length: 21 }, (_, index) => `Person-${String(index).padStart(2, "0")}`)
      for (const term of terms) {
        now += 1
        const key = ["community", "user-search", term]
        await source.client.query({ queryKey: key, queryFn: ({ client, signal }) => searchCommunityUsers(term, client, { signal }) })
        expect(source.client.getQueryState(key)?.dataUpdatedAt).toBe(now)
      }
      const second = await saveAndRestore(source)
      expect(second.client.getQueryData(rosterKey)).toBeUndefined()
      expect(second.client.getQueryData(["community", "user-search", terms[0]])).toBeUndefined()
      expect(second.client.getQueriesData({ queryKey: ["community", "user-search"] })).toHaveLength(20)
      for (const term of terms.slice(1)) expect(second.client.getQueryData(["community", "user-search", term])).toEqual({ ids: [term], observed: false })
    } finally { clock.mockRestore() }
  })

  it.each([false, true])("keeps a legitimate null creator distinct from a missing required profile (missing=%s)", async missing => {
    const source = await seed(false)
    const key = communityKeys.invites("server")
    api.mockResolvedValueOnce(invitesReadFixture("server", [{ id: "invite-profile", token: "profile-token", creatorId: missing ? "creator" : null, uses: 0, maxUses: null, expiresAt: null, createdAt: "2026-11-01T00:00:00Z" }], missing ? [profileResourceFixture({ id: "creator" })] : [], source.account))
    await source.client.query({ queryKey: key, queryFn: invitesQueryFn("server") })
    if (missing) await source.registry.collections.profiles.utils.writeDelete("creator")
    const second = await saveAndRestore(source)
    expect(second.client.getQueryData(rosterKey)).toBeDefined()
    if (missing) expect(second.client.getQueryData(key)).toBeUndefined()
    else expect(second.client.getQueryData(key)).toMatchObject({ invites: [{ code: "profile-token", creatorId: null }] })
  })

  it("does not resurrect a purged server roster from a late old writer and keeps another server window", async () => {
    const source = await seed(false)
    await publishCommunityResourceBundle(source.client, fullResourceBundleFixture(source.account,
      [serverResourceFixture({ id: "keep", ownerId: source.account })], []), { token: captureCommunityLiveSnapshotToken(source.client) })
    api.mockResolvedValueOnce(invitesReadFixture("keep", [{ id: "invite-keep", token: "keep-token", creatorId: source.account, uses: 0, maxUses: null, expiresAt: null, createdAt: "2026-11-01T00:00:00Z" }], [profileResourceFixture({ id: source.account })], source.account))
    const keepKey = communityKeys.invites("keep")
    await source.client.query({ queryKey: keepKey, queryFn: invitesQueryFn("keep") })
    const writer = createIdbPersister(source.account)
    persisters.push(writer)
    const retire = vi.fn(writer.retireAuxiliaryScopes)
    source.registry.bindAuthentication(() => source.account, writer.retireAccount, writer.retireChannels, retire)
    const snapshot = { timestamp: Date.now(), buster: PERSIST_BUSTER, clientState: dehydrate(source.client, { shouldDehydrateQuery: shouldDehydrateCommunityQuery }) }
    await writer.persistClient(snapshot)
    await completeCommunityPublication(source.registry, () => purgeCommunityServer(source.registry, "server"))
    await Promise.all(retire.mock.results.map(result => result.value))
    expect(source.client.getQueryData(rosterKey)).toBeUndefined()
    await writer.persistClient({ ...snapshot, timestamp: snapshot.timestamp + 1 })
    writer.stopPersisting()
    const second = await restoreSavedOwner(source)
    expect(second.client.getQueryData(keepKey)).toMatchObject({ invites: [{ code: "keep-token" }] })
    expect(second.client.getQueryData(rosterKey)).toBeUndefined()
  })

  it("keeps every live invite creator through unrelated scope GC while dropping the oversized disk window", async () => {
    const source = await seed(false)
    await publishCommunityResourceBundle(source.client, fullResourceBundleFixture(source.account,
      [serverResourceFixture({ id: "disposable", ownerId: source.account })], []), { token: captureCommunityLiveSnapshotToken(source.client) })
    const profiles = Array.from({ length: 401 }, (_, index) => profileResourceFixture({ id: `creator-${index}`, name: `Creator ${index}` }))
    const invites = profiles.map((profile, index) => ({ id: `invite-${index}`, token: `token-${index}`, creatorId: profile.id, uses: 0, maxUses: null, expiresAt: null, createdAt: "2026-11-01T00:00:00Z" }))
    api.mockResolvedValueOnce(invitesReadFixture("server", invites, profiles, source.account))
    const key = communityKeys.invites("server")
    await source.client.query({ queryKey: key, queryFn: invitesQueryFn("server") })
    expect(source.client.getQueryData(key)).toMatchObject({ invites: invites.map(invite => ({ code: invite.token, creatorId: invite.creatorId })) })
    await completeCommunityPublication(source.registry, () => purgeCommunityServer(source.registry, "disposable"))
    expect(source.registry.collections.servers.has("disposable")).toBe(false)
    expect(profiles.filter(profile => source.registry.collections.profiles.has(profile.id)).map(profile => profile.id)).toEqual(profiles.map(profile => profile.id))
    const second = await saveAndRestore(source)
    expect(second.client.getQueryData(key)).toBeUndefined()
    expect(second.client.getQueryData(rosterKey)).toMatchObject({ pages: [{ members: [{ userId: "peer" }] }] })
  })

  it.each([false, true])("restores a successful roster and total, then retains it through an actual failed refresh and another save (empty=%s)", async empty => {
    const source = await seed(empty)
    const expected = { pages: [{ members: empty ? [] : [{ id: "member-peer", userId: "peer" }], hasMore: false, limit: 100, total: empty ? 0 : 1 }], pageParams: [null] }
    const timestamp = source.client.getQueryState(rosterKey)!.dataUpdatedAt
    const second = await saveAndRestore(source)
    expect(second.registry).not.toBe(source.registry)
    expect(second.client).not.toBe(source.client)
    expect(second.client.getQueryData(rosterKey)).toMatchObject(expected)
    if (!empty) {
      expect(second.registry.collections.serverMemberships.get(serverMembershipKey("server", "peer"))?.memberId).toBe("member-peer")
      expect(second.registry.collections.profiles.get("peer")?.name).toBe("Saved peer")
    }
    api.mockRejectedValue(new Error("Roster refresh unavailable"))
    await expect(second.client.infiniteQuery({ queryKey: rosterKey, queryFn: membersPageQueryFn("server"), initialPageParam: null, staleTime: 0, retry: false })).rejects.toThrow("Roster refresh unavailable")
    expect(api).toHaveBeenCalledTimes(2)
    expect(second.client.getQueryState(rosterKey)).toMatchObject({ status: "error", dataUpdatedAt: timestamp })
    expect(second.client.getQueryData(rosterKey)).toMatchObject(expected)
    const third = await saveAndRestore(second)
    expect(third.client.getQueryData(rosterKey)).toMatchObject(expected)
    expect(third.client.getQueryState(rosterKey)).toMatchObject({ status: "success", fetchStatus: "idle", isInvalidated: true, dataUpdatedAt: timestamp })
  })
})


describe("optional persistence read qualification", () => {
  function failNextReadonly() {
    let failed = false
    const original = IDBDatabase.prototype.transaction
    return vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function (this: IDBDatabase, ...args: Parameters<typeof original>) {
      if (args[1] === "readonly" && !failed) {
        failed = true
        throw new DOMException("Optional read qualification unavailable", "UnknownError")
      }
      return original.apply(this, args)
    })
  }

  async function bindWriter(source: Owner) {
    const writer = createIdbPersister(source.account)
    persisters.push(writer)
    expect(await writer.isCurrent()).toBe(true)
    source.registry.bindAuthentication(() => source.account, writer.retireAccount, writer.retireChannels, writer.retireAuxiliaryScopes, writer.captureAuxiliaryReadEpoch)
    return writer
  }

  const refresh = (source: Owner) => source.client.infiniteQuery({ queryKey: rosterKey, queryFn: membersPageQueryFn("server"), initialPageParam: null, staleTime: 0, retry: false })
  const snapshot = (source: Owner, timestamp: number) => ({ timestamp, buster: PERSIST_BUSTER, clientState: dehydrate(source.client, { shouldDehydrateQuery: shouldDehydrateCommunityQuery }) })
  const savedRoster = async (account: string) => {
    const disk = JSON.parse((await get<string>(blobKeyFor(account), cacheStore))!)
    return disk.clientState.queries.find((query: { queryKey: unknown[] }) => JSON.stringify(query.queryKey) === JSON.stringify(rosterKey))
  }

  it.each([false, true])("keeps the original member GET reachable when optional IDB proof fails=%s", async failCapture => {
    const source = await seed(false)
    await bindWriter(source)
    const fault = failCapture ? failNextReadonly() : undefined
    try { await expect(refresh(source)).resolves.toBeDefined() }
    finally { fault?.mockRestore() }
    expect(api).toHaveBeenCalledTimes(2)
    expect(source.client.getQueryData(rosterKey)).toMatchObject({ pages: [{ observed: true, total: 1 }] })
  })

  it("keeps an unavailable proof out of retired disk windows while the same writer accepts a later actual read", async () => {
    const source = await seed(false)
    const writer = await bindWriter(source)
    const start = Date.now()
    const old = snapshot(source, start)
    await writer.persistClient(old)
    expect(await savedRoster(source.account)).toBeDefined()
    await writer.retireAuxiliaryScopes([{ kind: "server", id: "server" }])
    const fault = failNextReadonly()
    try { await expect(refresh(source)).resolves.toBeDefined() }
    finally { fault.mockRestore() }
    expect(api).toHaveBeenCalledTimes(2)
    expect(source.client.getQueryData(rosterKey)).toMatchObject({ pages: [{ observed: true, members: [{ userId: "peer" }] }] })
    const unknown = snapshot(source, start + 1)
    await writer.persistClient(unknown)
    expect(await savedRoster(source.account)).toBeUndefined()
    await refresh(source)
    expect(api).toHaveBeenCalledTimes(3)
    const fresh = snapshot(source, start + 2)
    await writer.persistClient(fresh)
    expect(await savedRoster(source.account)).toBeDefined()
    for (const [index, stale] of [old, unknown].entries()) {
      await writer.persistClient({ ...stale, timestamp: start + 3 + index })
      expect(await savedRoster(source.account)).toBeUndefined()
    }
    await writer.persistClient({ ...fresh, timestamp: start + 5 })
    writer.stopPersisting()
    const restored = await restoreSavedOwner(source)
    expect(restored.client).not.toBe(source.client)
    expect(restored.client.getQueryData(rosterKey)).toMatchObject({ pages: [{ members: [{ userId: "peer" }], observed: false }] })
  })

  it("preserves the original transport rejection after optional proof capture fails", async () => {
    const source = await seed(false)
    await bindWriter(source)
    const error = new Error("Original directory transport failure")
    api.mockRejectedValueOnce(error)
    const fault = failNextReadonly()
    try { await expect(refresh(source)).rejects.toBe(error) }
    finally { fault.mockRestore() }
    expect(api).toHaveBeenCalledTimes(2)
  })
})
