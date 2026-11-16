import "fake-indexeddb/auto"
import { afterEach, describe, expect, it } from "vitest"
import { dehydrate, QueryClient } from "@tanstack/react-query"
import { persistQueryClientRestore } from "@tanstack/react-query-persist-client"
import { get } from "idb-keyval"
import { channelResourceFixture, forumFeedScenarioFixture, fullResourceBundleFixture, messageResourceFixture, profileResourceFixture, serverResourceFixture } from "@/test/community-resource-fixtures"
import { createCommunityDbRegistry, type CommunityDbRegistry } from "@/lib/community-db/collections"
import { captureCommunityLiveSnapshotToken, discardCommunityRestoreReplacements, publishCommunityForumFeed, publishCommunityFriendships, publishCommunityResourceBundle, restoreCommunityCollections } from "@/lib/community-db/sync"
import { writeCommunityCollectionRows } from "@/lib/community-db/write"
import { forumFeedWindow, normalizeThreadResources } from "@/lib/community/forum-feed-window"
import { readPageListWindow } from "@/lib/community/page-list-persistence"
import { restoreConversationDisplayWindows } from "@/lib/community/restored-conversation-window"
import { communityKeys } from "./query-keys"
import { cacheStore } from "./query-cache-store"
import { blobKeyFor } from "./persisted-account-identity"
import { clearPersistedCache, createCommunityRestorePersister, createIdbPersister, PERSIST_BUSTER, PERSIST_MAX_AGE_MS, shouldDehydrateCommunityQuery } from "./query-persister"

const owners = new Set<CommunityDbRegistry>()
const accounts = new Set<string>()
const persisters: ReturnType<typeof createIdbPersister>[] = []
const keys = [communityKeys.forumFeed("forum", null), communityKeys.friends(), communityKeys.inboxMarked()]

afterEach(async () => {
  for (const persister of persisters) persister.stopPersisting()
  persisters.length = 0
  for (const owner of owners) { await owner.cleanup(); owner.queryClient.clear() }
  owners.clear()
  for (const account of accounts) await clearPersistedCache(account)
  accounts.clear()
})

async function seed(empty = false) {
  const account = `page-lists-${crypto.randomUUID()}`
  accounts.add(account)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const registry = createCommunityDbRegistry(client, account)
  owners.add(registry)
  await registry.preload()
  const channels = [channelResourceFixture({ id: "forum", type: "forum", serverId: "server", creatorId: account }),
    channelResourceFixture({ id: "dm", type: "dm", serverId: null, creatorId: account }),
    ...empty ? [] : [channelResourceFixture({ id: "post", type: "thread", serverId: "server", creatorId: account, parentChannelId: "forum", parentMessageId: "opener" })]]
  const messages = empty ? [] : [messageResourceFixture({ id: "opener", channelId: "forum", authorId: "peer", content: "Saved title" }),
    messageResourceFixture({ id: "body", channelId: "post", authorId: "peer", content: "Saved first body" }),
    messageResourceFixture({ id: "marked", channelId: "dm", authorId: "peer", content: "Saved marked body" })]
  await publishCommunityResourceBundle(client, fullResourceBundleFixture(account,
    [serverResourceFixture({ id: "server", ownerId: account })], channels, messages,
    [profileResourceFixture({ id: account }), profileResourceFixture({ id: "peer", name: "Peer" })]), { token: captureCommunityLiveSnapshotToken(client) })
  const page = normalizeThreadResources("forum", forumFeedScenarioFixture("forum", {
    serverId: "server", parentType: "forum", hasMore: false,
    threads: empty ? [] : [{ id: "post", creatorId: account, parentMessageId: "opener" }],
    included: { parentMessages: empty ? [] : [messages[0]], firstMessages: empty ? [] : [{ ...messages[1], channelId: "post", content: "Saved first body" }],
      participants: empty ? [] : [{ channelId: "post", userId: "peer", userName: "Peer" }] },
  }))
  await client.query({ queryKey: keys[0], queryFn: async () => {
    await publishCommunityForumFeed(client, "forum", page, { token: captureCommunityLiveSnapshotToken(client) })
    return { pages: [forumFeedWindow(page)], pageParams: [null] }
  } })
  await client.query({ queryKey: keys[1], queryFn: async () => {
    const rows = empty ? [] : [{ id: "friend", userId: "peer", kind: "accepted" as const }]
    await publishCommunityFriendships(client, rows, { token: captureCommunityLiveSnapshotToken(client) })
    return { ids: rows.map(row => row.id) }
  } })
  await client.query({ queryKey: keys[2], queryFn: async () => ({ marked: empty ? [] : [{ id: "mark-row", server: "Peer", serverId: null, channel: "DM", channelId: "dm", parentChannelId: null, m: { id: "marked" } }] }) })
  return { account, client, registry }
}

async function saveAndRestore(source: Awaited<ReturnType<typeof seed>>) {
  const writer = createIdbPersister(source.account)
  persisters.push(writer)
  const before = await get<string>(blobKeyFor(source.account), cacheStore)
  const timestamp = Math.max(Date.now(), before ? JSON.parse(before).timestamp + 1 : 0)
  const failedKeys = source.client.getQueryCache().getAll().filter(query => query.state.status === "error").map(query => query.queryKey)
  await writer.persistClient({ timestamp, buster: PERSIST_BUSTER, clientState: dehydrate(source.client, { shouldDehydrateQuery: shouldDehydrateCommunityQuery }) })
  for (const key of failedKeys) expect(source.client.getQueryState(key)?.status).toBe("error")
  const committed = await get<string>(blobKeyFor(source.account), cacheStore)
  expect(JSON.parse(committed!).timestamp).toBe(timestamp)
  if (before) expect(committed).not.toBe(before)
  writer.stopPersisting()
  await source.registry.cleanup()
  owners.delete(source.registry)
  source.client.clear()
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const registry = createCommunityDbRegistry(client, source.account, { waitForRestore: gate })
  owners.add(registry)
  const reader = createIdbPersister(source.account)
  persisters.push(reader)
  const restore = createCommunityRestorePersister(reader, source.account)
  await persistQueryClientRestore({ queryClient: client, persister: restore.persister, buster: PERSIST_BUSTER, maxAge: PERSIST_MAX_AGE_MS })
  const input = restore.takeCollections()
  try { await restoreCommunityCollections(registry, input); registry.captureRestoredCollections(input); registry.runtime.ws.actions.activateProfileAccount(source.account) }
  finally { discardCommunityRestoreReplacements(registry); release() }
  await registry.preload()
  restoreConversationDisplayWindows(registry, input)
  return { account: source.account, client, registry }
}

describe("native page-list transport limits", () => {
  it("accepts 100 complete Forum references and rejects the otherwise identical 101-reference page", () => {
    const window = (count: number) => ({ pages: [{ serverId: "server", parentType: "forum", hasMore: true, nextCursor: "cursor",
      threads: Array.from({ length: count }, (_, index) => ({ id: `post-${index}`, openerMessageId: `opener-${index}`, participantIds: [] })) }], pageParams: [null] })
    expect(readPageListWindow(keys[0], window(100))).toEqual({ kind: "forum", channelId: "forum", tag: null, data: window(100) })
    expect(readPageListWindow(keys[0], window(101))).toBeUndefined()
  })

  it("accepts 200 complete Marked references and rejects the otherwise identical 201-reference result", () => {
    const window = (count: number) => ({ marked: Array.from({ length: count }, (_, index) => ({
      id: `mark-${index}`, server: "", serverId: null, channel: "DM", channelId: "dm", parentChannelId: null, m: { id: `message-${index}` },
    })) })
    expect(readPageListWindow(keys[2], window(200))).toEqual({ kind: "marked", data: window(200) })
    expect(readPageListWindow(keys[2], window(201))).toBeUndefined()
  })
})

describe("page lists through actual IDB and new canonical owners", () => {
  it.each([false, true])("restores qualified windows and canonical rows with empty=%s", async empty => {
    const owner = await seed(empty)
    const expected = keys.map(key => structuredClone(owner.client.getQueryData(key)))
    const next = await saveAndRestore(owner)
    expect(next.registry).not.toBe(owner.registry)
    keys.forEach((key, index) => expect(next.client.getQueryData(key)).toEqual(expected[index]))
    expect(next.registry.collections.messages.get("body")?.content).toBe(empty ? undefined : "Saved first body")
    expect(next.registry.collections.messages.get("marked")?.content).toBe(empty ? undefined : "Saved marked body")
    expect([...next.registry.collections.friendships.values()]).toHaveLength(empty ? 0 : 1)
  })

  it.each([false, true])("saves last-success data after ownerB refresh errors and restores ownerC with empty=%s", async empty => {
    const first = await seed(empty)
    const expected = keys.map(key => structuredClone(first.client.getQueryData(key)))
    const updatedAt = keys.map(key => first.client.getQueryState(key)!.dataUpdatedAt)
    const second = await saveAndRestore(first)
    keys.forEach((key, index) => expect(second.client.getQueryData(key)).toEqual(expected[index]))
    for (const key of keys) {
      await second.client.query({ queryKey: key, queryFn: async () => { throw new Error("Refresh unavailable") }, staleTime: 0, retry: false }).catch(() => undefined)
      expect(second.client.getQueryState(key)?.status).toBe("error")
    }
    const third = await saveAndRestore(second)
    keys.forEach((key, index) => {
      expect(third.client.getQueryData(key)).toEqual(expected[index])
      expect(third.client.getQueryState(key)).toMatchObject({ dataUpdatedAt: updatedAt[index], isInvalidated: true, status: "success", fetchStatus: "idle" })
    })
  })

  it.each([["body", keys[0]], ["marked", keys[2]]] as const)("withdraws a window missing canonical %s without inventing an empty result", async (id, key) => {
    const owner = await seed()
    await writeCommunityCollectionRows(owner.registry, "messages", [...owner.registry.collections.messages.values()].filter(row => row.id !== id), row => row.id)
    const next = await saveAndRestore(owner)
    expect(next.client.getQueryData(key)).toBeUndefined()
    expect(next.client.getQueryData(keys[1])).toEqual({ ids: ["friend"] })
  })

  it.each(["opener-scope", "body-scope", "marked-scope", "participant-profile", "friend-row", "server"])("withdraws incomplete or mismatched %s references", async invalid => {
    const owner = await seed()
    if (invalid.endsWith("scope")) {
      const id = invalid.split("-")[0]
      await writeCommunityCollectionRows(owner.registry, "messages", [...owner.registry.collections.messages.values()].map(row => row.id === id ? { ...row, channelId: "wrong-scope" } : row), row => row.id)
    } else if (invalid === "participant-profile") await writeCommunityCollectionRows(owner.registry, "profiles", [...owner.registry.collections.profiles.values()].filter(row => row.id !== "peer"), row => row.id)
    else if (invalid === "friend-row") await writeCommunityCollectionRows(owner.registry, "friendships", [], row => row.id)
    else await writeCommunityCollectionRows(owner.registry, "servers", [], row => row.id)
    const next = await saveAndRestore(owner)
    const key = invalid.startsWith("marked") ? keys[2] : invalid === "friend-row" ? keys[1] : keys[0]
    expect(next.client.getQueryData(key)).toBeUndefined()
  })

  it("keeps one complete first page and its original continuation, never a truncated list", async () => {
    const owner = await seed()
    const page = owner.client.getQueryData<{ pages: unknown[] }>(keys[0])!.pages[0] as Record<string, unknown>
    owner.client.setQueryData(keys[0], { pages: [{ ...page, hasMore: true, nextCursor: "original-cursor" }, page], pageParams: [null, "original-cursor"] })
    const next = await saveAndRestore(owner)
    expect(next.client.getQueryData(keys[0])).toEqual({ pages: [{ ...page, hasMore: true, nextCursor: "original-cursor" }], pageParams: [null] })
  })

  it("keeps firstMessageId=null and does not require a post notify relation", async () => {
    const owner = await seed()
    await writeCommunityCollectionRows(owner.registry, "channels", [...owner.registry.collections.channels.values()].map(row => row.id === "post" ? { ...row, firstMessageId: null } : row), row => row.id)
    await writeCommunityCollectionRows(owner.registry, "channelMemberships", [...owner.registry.collections.channelMemberships.values()].filter(row => row.relation !== "notify"), row => row.id)
    const next = await saveAndRestore(owner)
    expect(next.client.getQueryData(keys[0])).toBeDefined()
  })

  it("bounds Forum retention to the latest twenty complete native windows", async () => {
    const owner = await seed()
    const data = owner.client.getQueryData(keys[0])
    const now = Date.now()
    for (let index = 0; index <= 20; index++) owner.client.setQueryData(communityKeys.forumFeed("forum", `tag-${index}`), data, { updatedAt: now + index + 1 })
    const next = await saveAndRestore(owner)
    expect(next.client.getQueryData(communityKeys.forumFeed("forum", "tag-0"))).toBeUndefined()
    for (let index = 1; index <= 20; index++) expect(next.client.getQueryData(communityKeys.forumFeed("forum", `tag-${index}`))).toBeDefined()
    expect(next.client.getQueryData(keys[0])).toBeUndefined()
  })

  it.each(["complete", "missing-reply", "wrong-reply-scope", "missing-reply-profile"])("keeps a %s Marked reply graph beyond ordinary trimming", async mode => {
    const owner = await seed()
    const messages = [...owner.registry.collections.messages.values()].map(row => row.id === "marked"
      ? messageResourceFixture({ id: row.id, channelId: row.channelId, authorId: row.authorId, content: row.content, seq: 2, replyToId: "reply", replyTo: { id: "reply", authorId: "reply-author", authorName: "Reply author" } }) : row)
    if (mode !== "missing-reply") messages.push(messageResourceFixture({ id: "reply", channelId: mode === "wrong-reply-scope" ? "forum" : "dm", authorId: "reply-author", seq: 1, content: "Quoted body" }))
    for (let seq = 3; seq <= 80; seq++) messages.push(messageResourceFixture({ id: `dm-recent-${seq}`, channelId: "dm", authorId: "peer", seq }))
    await writeCommunityCollectionRows(owner.registry, "messages", messages, row => row.id)
    if (mode !== "missing-reply-profile") await writeCommunityCollectionRows(owner.registry, "profiles", [...owner.registry.collections.profiles.values(), profileResourceFixture({ id: "reply-author" })], row => row.id)
    const next = await saveAndRestore(owner)
    if (mode === "complete") {
      expect(next.client.getQueryData(keys[2])).toBeDefined()
      expect(next.registry.collections.messages.get("reply")?.content).toBe("Quoted body")
    } else expect(next.client.getQueryData(keys[2])).toBeUndefined()
  })

  it.each(["cursor", "noninitial-page"])("rejects %s without converting it to empty", async invalid => {
    const owner = await seed()
    const data = structuredClone(owner.client.getQueryData<{ pages: Array<{ threads: object[]; hasMore: boolean }> }>(keys[0])!)
    if (invalid === "cursor") owner.client.setQueryData(keys[0], { ...data, pages: [{ ...data.pages[0], hasMore: true }] })
    else owner.client.setQueryData(keys[0], { ...data, pageParams: ["older-page"] })
    const next = await saveAndRestore(owner)
    expect(next.client.getQueryData(keys[0])).toBeUndefined()
  })

  it("withdraws late Forum/Marked writes after durable channel retirement and cannot restore another account", async () => {
    const owner = await seed()
    const writer = createIdbPersister(owner.account)
    persisters.push(writer)
    const snapshot = { timestamp: Date.now(), buster: PERSIST_BUSTER, clientState: dehydrate(owner.client, { shouldDehydrateQuery: shouldDehydrateCommunityQuery }) }
    await writer.persistClient(snapshot)
    const current = createIdbPersister(owner.account)
    persisters.push(current)
    await current.retireChannels(["post", "dm"], true)
    await writer.persistClient(snapshot)
    const restored = await current.restoreClient()
    for (const key of [keys[0], keys[2]]) expect(restored?.clientState.queries.some(query => JSON.stringify(query.queryKey) === JSON.stringify(key))).toBe(false)
    const account = `other-${crypto.randomUUID()}`
    accounts.add(account)
    const other = createIdbPersister(account)
    persisters.push(other)
    expect(await other.restoreClient()).toBeUndefined()
  })

  it("does not persist an initial error or broaden failed-query policy for other lists", async () => {
    const owner = await seed()
    for (const key of keys) {
      owner.client.removeQueries({ queryKey: key, exact: true })
      await owner.client.query({ queryKey: key, queryFn: async () => { throw new Error("Initial unavailable") } }).catch(() => undefined)
    }
    owner.client.setQueryData(communityKeys.machines(), { machines: [], complete: true })
    await owner.client.query({ queryKey: communityKeys.machines(), queryFn: async () => { throw new Error("Refresh unavailable") }, staleTime: 0 }).catch(() => undefined)
    const next = await saveAndRestore(owner)
    for (const key of [...keys, communityKeys.machines()]) expect(next.client.getQueryData(key)).toBeUndefined()
  })

  it("retains the exact Forum opener/first-body and Marked target beyond the ordinary message bounds", async () => {
    const owner = await seed()
    const channels = [...owner.registry.collections.channels.values()]
    const messages = [...owner.registry.collections.messages.values()]
    for (let index = 0; index < 22; index++) {
      const id = `recent-${index}`
      channels.push({ ...channels.find(row => row.id === "dm")!, id })
      messages.push(messageResourceFixture({ id: `recent-message-${index}`, channelId: id, authorId: "peer", seq: 1000 + index }))
    }
    for (const channelId of ["forum", "dm"]) for (let seq = 2; seq <= 80; seq++) messages.push(messageResourceFixture({ id: `${channelId}-${seq}`, channelId, authorId: "peer", seq }))
    await writeCommunityCollectionRows(owner.registry, "channels", channels, row => row.id)
    await writeCommunityCollectionRows(owner.registry, "messages", messages, row => row.id)
    const next = await saveAndRestore(owner)
    expect(next.client.getQueryData(keys[0])).toBeDefined()
    expect(next.client.getQueryData(keys[2])).toBeDefined()
    expect(next.registry.collections.messages.get("opener")?.content).toBe("Saved title")
    expect(next.registry.collections.messages.get("body")?.content).toBe("Saved first body")
    expect(next.registry.collections.messages.get("marked")?.content).toBe("Saved marked body")
  })
})
