import "fake-indexeddb/auto"
import { afterEach, describe, expect, it, vi } from "vitest"
import { dehydrate, QueryClient } from "@tanstack/react-query"
import { persistQueryClientRestore } from "@tanstack/react-query-persist-client"
import { get } from "idb-keyval"
import { forumTagsQueryFn, pinsQueryFn, threadsQueryFn } from "@/hooks/community/use-channel-panels"
import { forumPostCountsQueryFn } from "@/hooks/community/use-forum-post-counts"
import { channelResourceFixture, forumFeedScenarioFixture, fullResourceBundleFixture, messageResourceFixture, profileResourceFixture, serverResourceFixture } from "@/test/community-resource-fixtures"
import { createCommunityDbRegistry, type CommunityDbRegistry } from "./community-db/collections"
import { captureCommunityLiveSnapshotToken, discardCommunityRestoreReplacements, publishCommunityResourceBundle, restoreCommunityCollections } from "./community-db/sync"
import { writeCommunityCollectionRows } from "./community-db/write"
import { communityKeys } from "./query-keys"
import { cacheStore } from "./query-cache-store"
import { blobKeyFor } from "./persisted-account-identity"
import { clearPersistedCache, createCommunityRestorePersister, createIdbPersister, PERSIST_BUSTER, PERSIST_MAX_AGE_MS, shouldDehydrateCommunityQuery } from "./query-persister"

const api = vi.hoisted(() => vi.fn())
vi.mock("@/lib/api/client", () => ({ apiFetch: api, toastApiError: vi.fn() }))
const owners = new Set<CommunityDbRegistry>()
const accounts = new Set<string>()
const persisters: ReturnType<typeof createIdbPersister>[] = []
const keys = [communityKeys.forumTags("forum"), communityKeys.pins("text"), communityKeys.threads("text"), communityKeys.forumPostCounts("server")]

afterEach(async () => {
  for (const persister of persisters.splice(0)) persister.stopPersisting()
  for (const registry of owners) { await registry.cleanup(); registry.queryClient.clear() }
  owners.clear()
  for (const account of accounts) await clearPersistedCache(account)
  accounts.clear()
  api.mockReset()
})

async function seed(empty = false) {
  const account = `auxiliary-${crypto.randomUUID()}`
  accounts.add(account)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const registry = createCommunityDbRegistry(client, account)
  owners.add(registry)
  await registry.preload()
  const channels = [channelResourceFixture({ id: "forum", type: "forum", serverId: "server", creatorId: account }),
    channelResourceFixture({ id: "text", type: "text", serverId: "server", creatorId: account }),
    ...empty ? [] : [channelResourceFixture({ id: "thread", type: "thread", serverId: "server", creatorId: account,
      parentChannelId: "text", parentMessageId: "opener" })]]
  const messages = empty ? [] : [
    messageResourceFixture({ id: "pin", channelId: "text", authorId: "peer", seq: 2, content: "Saved pinned body", replyToId: "reply", replyTo: { id: "reply", authorId: "peer", authorName: "Peer" } }),
    messageResourceFixture({ id: "reply", channelId: "text", authorId: "peer", seq: 1, content: "Saved quoted body" }),
    messageResourceFixture({ id: "opener", channelId: "text", authorId: "peer", seq: 3, content: "Saved parent body" }),
    messageResourceFixture({ id: "first", channelId: "thread", authorId: "peer", seq: 1, content: "Saved first body" }),
  ]
  const bundle = fullResourceBundleFixture(account, [serverResourceFixture({ id: "server", ownerId: account })], channels, messages,
    [profileResourceFixture({ id: account }), profileResourceFixture({ id: "peer", name: "Peer" })])
  const pinBundle = fullResourceBundleFixture(account, [serverResourceFixture({ id: "server", ownerId: account })],
    [channels[1]!], messages.filter(row => row.id === "pin" || row.id === "reply"),
    [profileResourceFixture({ id: account }), profileResourceFixture({ id: "peer", name: "Peer" })])
  await publishCommunityResourceBundle(client, bundle, { token: captureCommunityLiveSnapshotToken(client) })
  const threads = forumFeedScenarioFixture("text", { serverId: "server", parentType: "text", hasMore: false,
    threads: empty ? [] : [{ id: "thread", creatorId: account, name: "Saved thread", parentMessageId: "opener" }],
    included: { parentMessages: empty ? [] : [messages[2]], firstMessages: empty ? [] : [messages[3]], participants: [] },
  })
  api.mockImplementation(async (path: string) => {
    if (path.endsWith("/messages/tags")) return { tags: empty ? [] : ["catalog-only", "work"] }
    if (path.endsWith("/pins")) return { pins: empty ? [] : [{ id: "pin" }], resources: pinBundle }
    if (path.includes("/threads?")) return threads
    if (path.endsWith("/forum-counts")) return { serverId: "server", counts: { forum: empty ? 0 : 12 } }
    throw new Error(`Unexpected auxiliary fixture read: ${path}`)
  })
  const readers = [forumTagsQueryFn("forum", client), pinsQueryFn("text", client), threadsQueryFn("text", client), forumPostCountsQueryFn("server", client)]
  for (let index = 0; index < keys.length; index++) await client.query({ queryKey: keys[index]!, queryFn: readers[index]! })
  return { account, client, registry }
}

type Owner = Awaited<ReturnType<typeof seed>>

async function saveAndRestore(source: Owner) {
  const writer = createIdbPersister(source.account)
  persisters.push(writer)
  const before = await get<string>(blobKeyFor(source.account), cacheStore)
  const timestamp = Math.max(Date.now(), before ? JSON.parse(before).timestamp + 1 : 0)
  const failed = source.client.getQueryCache().getAll().filter(query => query.state.status === "error")
  await writer.persistClient({ timestamp, buster: PERSIST_BUSTER, clientState: dehydrate(source.client, { shouldDehydrateQuery: shouldDehydrateCommunityQuery }) })
  for (const query of failed) expect(query.state.status).toBe("error")
  const raw = await get<string>(blobKeyFor(source.account), cacheStore)
  expect(JSON.parse(raw!).timestamp).toBe(timestamp)
  writer.stopPersisting()
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

describe("auxiliary reads through actual IDB and new canonical owners", () => {
  it.each([false, true])("restores all four successful reads with empty=%s", async empty => {
    const source = await seed(empty)
    expect(api).toHaveBeenCalledTimes(4)
    const next = await saveAndRestore(source)
    expect(next.registry).not.toBe(source.registry)
    expect(next.client.getQueryData(keys[0])).toEqual({ tags: empty ? [] : ["catalog-only", "work"], observed: false })
    expect(next.client.getQueryData(keys[1])).toEqual({ pins: empty ? [] : [{ id: "pin" }] })
    expect(next.client.getQueryData(keys[2])).toEqual({ serverId: "server", parentType: "text", parentChannelId: "text", threads: empty ? [] : [{ id: "thread", openerMessageId: "opener" }] })
    expect(next.client.getQueryData(keys[3])).toEqual({ forum: empty ? 0 : 12 })
    expect(next.registry.collections.messages.get("pin")?.content).toBe(empty ? undefined : "Saved pinned body")
    expect(next.registry.collections.messages.get("first")?.content).toBe(empty ? undefined : "Saved first body")
    expect([...next.registry.collections.channels.values()].flatMap(row => row.tags)).not.toContain("catalog-only")
  })

  it.each([false, true])("saves owner B last-success data after refresh errors and restores owner C with empty=%s", async empty => {
    const source = await seed(empty)
    const timestamps = keys.map(key => source.client.getQueryState(key)!.dataUpdatedAt)
    const second = await saveAndRestore(source)
    const expected = keys.map(key => structuredClone(second.client.getQueryData(key)))
    for (const key of keys) {
      await second.client.query({ queryKey: key, queryFn: async () => { throw new Error("Refresh unavailable") }, staleTime: 0, retry: false }).catch(() => undefined)
      expect(second.client.getQueryState(key)?.status).toBe("error")
    }
    const third = await saveAndRestore(second)
    keys.forEach((key, index) => {
      expect(third.client.getQueryData(key)).toEqual(expected[index])
      expect(third.client.getQueryState(key)).toMatchObject({ dataUpdatedAt: timestamps[index], status: "success", fetchStatus: "idle", isInvalidated: true })
    })
  })

  it.each(["pin", "reply", "opener"])("withdraws the window whose canonical %s is missing", async id => {
    const source = await seed()
    await writeCommunityCollectionRows(source.registry, "messages", [...source.registry.collections.messages.values()].filter(row => row.id !== id), row => row.id)
    const next = await saveAndRestore(source)
    expect(next.client.getQueryData(id === "pin" || id === "reply" ? keys[1] : keys[2])).toBeUndefined()
    expect(next.client.getQueryData(keys[0])).toEqual({ tags: ["catalog-only", "work"], observed: false })
    expect(next.client.getQueryData(keys[3])).toEqual({ forum: 12 })
  })

  it.each(["pin-scope", "thread-parent", "profile"])("rejects the %s dependency without inventing empty content", async invalid => {
    const source = await seed()
    if (invalid === "profile") await writeCommunityCollectionRows(source.registry, "profiles", [...source.registry.collections.profiles.values()].filter(row => row.id !== "peer"), row => row.id)
    else if (invalid === "thread-parent") await writeCommunityCollectionRows(source.registry, "channels", [...source.registry.collections.channels.values()].map(row => row.id === "thread" ? { ...row, parentChannelId: "forum" } : row), row => row.id)
    else {
      await writeCommunityCollectionRows(source.registry, "messages", [...source.registry.collections.messages.values()].map(row => row.id === "pin" ? { ...row, channelId: "forum" } : row), row => row.id)
    }
    const next = await saveAndRestore(source)
    expect(next.client.getQueryData(invalid === "pin-scope" ? keys[1] : keys[2])).toBeUndefined()
    if (invalid === "profile") expect(next.client.getQueryData(keys[1])).toBeUndefined()
  })

  it("keeps qualified old pin/reply and thread dependencies beyond ordinary tail trimming", async () => {
    const source = await seed()
    await writeCommunityCollectionRows(source.registry, "messages", [...source.registry.collections.messages.values(),
      ...Array.from({ length: 80 }, (_, index) => messageResourceFixture({ id: `recent-${index}`, channelId: "text", authorId: "peer", seq: index + 4 }))], row => row.id)
    const next = await saveAndRestore(source)
    expect(next.client.getQueryData(keys[1])).toEqual({ pins: [{ id: "pin" }] })
    for (const id of ["pin", "reply", "opener"]) expect(next.registry.collections.messages.has(id)).toBe(true)
  })

  it("does not require an unreferenced ordinary-thread first body", async () => {
    const source = await seed()
    expect(source.registry.collections.channels.get("thread")?.firstMessageId).toBeNull()
    await writeCommunityCollectionRows(source.registry, "messages", [...source.registry.collections.messages.values()].filter(row => row.id !== "first"), row => row.id)
    const next = await saveAndRestore(source)
    expect(next.client.getQueryData(keys[2])).toMatchObject({ threads: [{ id: "thread", openerMessageId: "opener" }] })
    expect(next.registry.collections.messages.has("first")).toBe(false)
  })

  it.each([false, true])("restores a child thread's own pinned list with empty=%s", async empty => {
    const source = await seed()
    const bundle = fullResourceBundleFixture(source.account, [serverResourceFixture({ id: "server", ownerId: source.account })], [
      channelResourceFixture({ id: "text", type: "text", serverId: "server", creatorId: source.account }),
      channelResourceFixture({ id: "thread", type: "thread", serverId: "server", creatorId: source.account, parentChannelId: "text", parentMessageId: "opener" }),
    ], empty ? [] : [messageResourceFixture({ id: "first", channelId: "thread", authorId: "peer", seq: 1, content: "Saved first body" })],
    [profileResourceFixture({ id: source.account }), profileResourceFixture({ id: "peer", name: "Peer" })])
    api.mockResolvedValue({ pins: empty ? [] : [{ id: "first" }], resources: bundle })
    const key = communityKeys.pins("thread")
    await source.client.query({ queryKey: key, queryFn: pinsQueryFn("thread", source.client) })
    const next = await saveAndRestore(source)
    expect(next.client.getQueryData(key)).toEqual({ pins: empty ? [] : [{ id: "first" }] })
  })

  it.each(["tags", "counts"])("rejects a late %s completion after access changes without replacing the successful read", async kind => {
    const source = await seed()
    let release!: (value: unknown) => void
    api.mockImplementation(() => new Promise(resolve => { release = resolve }))
    const key = kind === "tags" ? keys[0]! : keys[3]!
    const before = source.client.getQueryData(key)
    const request = source.client.query({ queryKey: key, queryFn: kind === "tags" ? forumTagsQueryFn("forum", source.client) : forumPostCountsQueryFn("server", source.client), staleTime: 0, retry: false })
    const rejected = expect(request).rejects.toThrow()
    await vi.waitFor(() => expect(release).toBeTypeOf("function"))
    source.registry.runtime.ws.setState(state => ({ ...state, accessEpoch: state.accessEpoch + 1 }))
    release(kind === "tags" ? { tags: ["late"] } : { serverId: "server", counts: { forum: 99 } })
    await rejected
    expect(source.client.getQueryData(key)).toEqual(before)
  })

  it("bounds additional successful read scopes without creating empty windows for evicted scopes", async () => {
    const source = await seed()
    const channels = Array.from({ length: 24 }, (_, index) => channelResourceFixture({ id: `catalog-${index}`, type: "forum", serverId: "server", creatorId: source.account }))
    await publishCommunityResourceBundle(source.client, fullResourceBundleFixture(source.account,
      [serverResourceFixture({ id: "server", ownerId: source.account })], channels, [], [profileResourceFixture({ id: source.account })]),
    { token: captureCommunityLiveSnapshotToken(source.client) })
    api.mockResolvedValue({ tags: ["Native complete catalog"] })
    for (const channel of channels) await source.client.query({ queryKey: communityKeys.forumTags(channel.id), queryFn: forumTagsQueryFn(channel.id, source.client) })
    const next = await saveAndRestore(source)
    const retained = next.client.getQueryCache().getAll().filter(query => query.queryKey[1] === "forum-post-counts"
      || query.queryKey.length === 4 && ["forum-tags", "pins", "threads"].includes(String(query.queryKey[3])))
    expect(retained).toHaveLength(20)
    const catalogs = channels.map(channel => next.client.getQueryData(communityKeys.forumTags(channel.id)))
    expect(catalogs.filter(data => data === undefined).length).toBeGreaterThan(0)
    for (const data of catalogs) if (data !== undefined) expect(data).toEqual({ tags: ["Native complete catalog"], observed: false })
  })

  it.each(["text", "thread", "forum"])("retains durable %s retirement against an old writer and another account", async scope => {
    const source = await seed()
    const writer = createIdbPersister(source.account), current = createIdbPersister(source.account)
    persisters.push(writer, current)
    const snapshot = { timestamp: Date.now(), buster: PERSIST_BUSTER, clientState: dehydrate(source.client, { shouldDehydrateQuery: shouldDehydrateCommunityQuery }) }
    await writer.persistClient(snapshot)
    await current.retireChannels(scope === "text" ? ["text", "thread"] : [scope], true)
    await writer.persistClient(snapshot)
    const restored = await current.restoreClient()
    const has = (key: readonly unknown[]) => restored?.clientState.queries.some(query => JSON.stringify(query.queryKey) === JSON.stringify(key))
    if (scope === "forum") { expect(has(keys[0]!)).toBe(false); expect(has(keys[3]!)).toBe(false); expect(has(keys[1]!)).toBe(true) }
    else { expect(has(keys[2]!)).toBe(false); expect(has(keys[0]!)).toBe(true); if (scope === "text") expect(has(keys[1]!)).toBe(false) }
    const other = `other-${crypto.randomUUID()}`
    accounts.add(other)
    const foreign = createIdbPersister(other)
    persisters.push(foreign)
    expect(await foreign.restoreClient()).toBeUndefined()
  })

  it("does not persist an initial read failure as an empty snapshot", async () => {
    const source = await seed()
    for (const key of keys) {
      source.client.removeQueries({ queryKey: key, exact: true })
      await source.client.query({ queryKey: key, queryFn: async () => { throw new Error("Initial unavailable") }, retry: false }).catch(() => undefined)
    }
    const next = await saveAndRestore(source)
    for (const key of keys) expect(next.client.getQueryData(key)).toBeUndefined()
  })
})
