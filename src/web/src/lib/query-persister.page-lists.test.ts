import { CommunityChannelResourceSchema, CommunityResourceProfileSchema } from "@alook/shared"
import { conversationEntryFromChannel, seedConversationEntry } from "@/test/conversation-entry-fixtures"
import { messageWindowPage } from "@/lib/community/models/message"
import { messageWindowOptions, type MessageWindowData } from "@/lib/community/message-window"
import "fake-indexeddb/auto"
import { afterEach, describe, expect, it, vi } from "vitest"
import { dehydrate, InfiniteQueryObserver, QueryClient } from "@tanstack/react-query"
import { persistQueryClientRestore } from "@tanstack/react-query-persist-client"
import { get } from "idb-keyval"
import { channelResourceFixture, forumFeedScenarioFixture, fullResourceBundleFixture, messageReadPageFixture, messageResourceFixture, profileResourceFixture, serverResourceFixture } from "@/test/community-resource-fixtures"
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
import { conversationEntryOptions, currentConversationReadState, findConversationDisplayWindow, findConversationEntryWindow, getQualifiedConversationScope } from "./community/conversation-entry"

const load = vi.hoisted(() => vi.fn())
vi.mock("@/lib/api/client", async original => ({ ...await original<typeof import("@/lib/api/client")>(), apiFetch: (...args: unknown[]) => load(...args) }))

const owners = new Set<CommunityDbRegistry>()
const accounts = new Set<string>()
const persisters: ReturnType<typeof createIdbPersister>[] = []
const keys = [communityKeys.forumFeed("forum", null), communityKeys.friends(), communityKeys.inboxMarked()]

afterEach(async () => {
  load.mockReset()
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
  for (const window of input.messageWindows ?? []) expect(client.getQueryData(window.key)).toBeUndefined()
  for (const window of input.messageWindows ?? []) expect(client.getQueryData(window.key)).toBeUndefined()
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
    expect(next.client.getQueryData(communityKeys.channelMessages("post"))).toBeUndefined()
  })
})

async function seedBodyWindow(owner: Awaited<ReturnType<typeof seed>>, count = 3) {
  const packet = conversationEntryFromChannel(CommunityChannelResourceSchema.strip().parse(owner.registry.collections.channels.get("post")), owner.account)
  packet.messages = Array.from({ length: count }, (_, index) => messageResourceFixture({ id: `read-${index + 1}`, channelId: "post", seq: index + 101,
    authorId: "peer", content: `Actual read ${index + 1}`, createdAt: new Date(Date.UTC(2026, 9, 1, 0, index)).toISOString() }))
  packet.profiles = [...owner.registry.collections.profiles.values()].map(row => CommunityResourceProfileSchema.strip().parse(row))
  packet.channel.messageCount = count
  packet.page = { olderCursor: null, newerCursor: null, hasMoreOlder: false, hasMoreNewer: false, latestSeq: count ? 100 + count : 0 }
  await seedConversationEntry(owner.client, packet)
  return { key: communityKeys.channelMessages("post"), packet }
}

describe("actual body membership through IDB and new canonical owners", () => {
  it("restores an explicit target after real newer pagination and bounded IDB replace its initial anchor page", async () => {
    const owner = await seed(), { key, packet } = await seedBodyWindow(owner, 126)
    const rows = packet.messages
    const anchor = "read-50"
    const target = { channelId: "post", serverId: "server", anchorMessageId: anchor }
    const cursor = (seq: number) => `${rows[seq - 101].createdAt}|read-${seq - 100}`
    const entry = { ...packet, messages: rows.filter(row => row.seq! >= 126 && row.seq! <= 176),
      selection: { reason: "explicit_anchor" as const, anchorMessageId: anchor },
      page: { olderCursor: cursor(125), newerCursor: cursor(175), hasMoreOlder: true, hasMoreNewer: true, latestSeq: 300 } }
    owner.client.removeQueries({ queryKey: key, exact: true })
    const seeded = await seedConversationEntry(owner.client, entry, target)
    const newer = messageReadPageFixture({ messages: rows.filter(row => row.seq! >= 177), olderCursor: cursor(176),
      newerCursor: cursor(225), hasMoreOlder: true, hasMoreNewer: true, latestSeq: 300 })
    load.mockResolvedValueOnce(newer)
    const observer = new InfiniteQueryObserver(owner.client, {
      ...messageWindowOptions(owner.client, "post", { mode: "anchor", anchor }), enabled: false,
    })
    const unsubscribe = observer.subscribe(() => undefined)
    try { await observer.fetchPreviousPage() } finally { unsubscribe() }
    expect(load.mock.calls[0][0]).toBe(`/api/community/channels/post/messages?since=${encodeURIComponent(cursor(175))}`)
    const paginated = owner.client.getQueryData<MessageWindowData>(seeded.resource.windowKey)!
    expect(paginated.pages[0].messages.map(row => row.id)).not.toContain(anchor)
    expect(paginated.pages[1].messages.map(row => row.id)).toContain(anchor)
    expect(paginated.pageParams).toEqual([{ mode: "newer", cursor: cursor(175) }, { mode: "anchor", anchor }])

    const next = await saveAndRestore(owner)
    const restored = next.client.getQueryData<MessageWindowData>(seeded.resource.windowKey)!
    expect(restored.pages).toHaveLength(1)
    expect(restored.pages[0].messages.map(row => row.seq)).toEqual(Array.from({ length: 50 }, (_, index) => index + 177))
    expect(restored.pageParams).toEqual([{ mode: "newer", cursor: cursor(175) }])
    const scope = getQualifiedConversationScope(next.client, target)!
    expect(findConversationDisplayWindow(next.client, target, scope)?.key).toEqual(seeded.resource.windowKey)
    expect(findConversationEntryWindow(next.client, target, scope, currentConversationReadState(next.client, "post"))).toBeUndefined()

    let release!: (value: typeof entry) => void
    const held = new Promise<typeof entry>(resolve => { release = resolve })
    load.mockReset()
    load.mockImplementation((url: string) => {
      const query = new URL(url, "https://alook.local").searchParams
      if (query.has("entry")) return held
      if (query.get("since") === cursor(175)) return Promise.resolve(newer)
      if (query.get("since") === cursor(226)) return Promise.resolve(messageReadPageFixture({
        messages: Array.from({ length: 50 }, (_, index) => messageResourceFixture({ id: `read-${index + 127}`, channelId: "post", seq: index + 227,
          authorId: "peer", createdAt: new Date(Date.UTC(2026, 9, 1, 0, index + 126)).toISOString() })),
        hasMoreOlder: true, hasMoreNewer: true, newerCursor: "after-276", latestSeq: 300,
      }))
      throw new Error(`Unexpected target repair read: ${url}`)
    })
    const received = next.client.query({ ...conversationEntryOptions(next.client, target), retry: false })
    await vi.waitFor(() => expect(load).toHaveBeenCalledOnce())
    expect(next.client.getQueryData(seeded.resource.windowKey)).toBe(restored)
    expect(findConversationDisplayWindow(next.client, target, scope)?.key).toEqual(seeded.resource.windowKey)
    release(entry)
    const resource = await received
    await next.client.getQueryCache().find({ queryKey: [...resource.windowKey, "reconcile"], exact: true })?.promise
    expect(next.registry.collections.messages.has(anchor)).toBe(true)
    expect(next.client.getQueryData<MessageWindowData>(resource.windowKey)?.pages.flatMap(page => page.messages.map(row => row.id))).toContain(anchor)
    expect(findConversationEntryWindow(next.client, target, resource, currentConversationReadState(next.client, "post"))?.key).toEqual(resource.windowKey)
    expect(load.mock.calls.filter(([url]) => !new URL(url, "https://alook.local").searchParams.has("entry"))).toEqual([])
  })

  it.each([0, 1, 3, 80].flatMap(count => [false, true].map(failed => ({ count, failed }))))("keeps $count actual members apart from preview/extra entities after refresh failed=$failed", async ({ count, failed }) => {
    const owner = await seed(), { key, packet } = await seedBodyWindow(owner, count)
    const extra = messageResourceFixture({ id: "scatter", channelId: "post", seq: 9999, authorId: "peer", content: "Not a read-window member" })
    await writeCommunityCollectionRows(owner.registry, "messages", [...owner.registry.collections.messages.values(), extra], row => row.id)
    const updatedAt = owner.client.getQueryState(key)!.dataUpdatedAt
    if (failed) await owner.client.query({ queryKey: key, staleTime: 0, retry: false, queryFn: async () => { throw new Error("Body refresh unavailable") } }).catch(() => undefined)
    const next = await saveAndRestore(owner)
    const expected = packet.messages.slice(-50).map(row => row.id)
    expect(next.client.getQueryData<MessageWindowData>(key)?.pages.flatMap(page => page.messages.map(row => row.id))).toEqual(expected)
    expect(next.client.getQueryData<MessageWindowData>(key)?.pageParams).toEqual([{ mode: "newest" }])
    expect(next.client.getQueryState(key)?.dataUpdatedAt).toBe(updatedAt)
    expect(next.registry.collections.messages.get("body")?.content).toBe("Saved first body")
    const disk = JSON.parse((await get<string>(blobKeyFor(owner.account), cacheStore))!)
    const saved = disk.clientState.queries.find((query: { queryKey: unknown[] }) => JSON.stringify(query.queryKey) === JSON.stringify(key))
    expect(saved.state.data.pages.flatMap((page: { messages: unknown[] }) => page.messages)).toEqual(packet.messages.slice(-50).map(({ id, seq }) => ({ id, seq })))
    if (count > 50) expect(saved.state.data.pages[0]).toMatchObject({ hasMoreOlder: true, olderCursor: `${packet.messages[30].createdAt}|read-31` })
    else expect(saved.state.data.pages[0]).toMatchObject({ hasMoreOlder: false, hasMoreNewer: false })
    const third = await saveAndRestore(next)
    expect(third.client.getQueryData<MessageWindowData>(key)?.pages.flatMap(page => page.messages.map(row => row.id))).toEqual(expected)
    expect(third.client.getQueryData(keys[0])).toBeDefined()
  })

  it.each(["missing-member", "wrong-scope", "duplicate", "missing-profile", "missing-access", "missing-parent", "page-param", "initial-error"])("rejects %s without assembling the remaining preview into a body window", async invalid => {
    const owner = await seed(), { key } = await seedBodyWindow(owner)
    const data = structuredClone(owner.client.getQueryData<MessageWindowData>(key)!)
    if (invalid === "missing-member") await writeCommunityCollectionRows(owner.registry, "messages", [...owner.registry.collections.messages.values()].filter(row => row.id !== "read-2"), row => row.id)
    if (invalid === "wrong-scope") data.pages[0].messages[1] = { id: "marked" }
    if (invalid === "duplicate") data.pages[0].messages[1] = { ...data.pages[0].messages[0] }
    if (invalid === "missing-profile") await writeCommunityCollectionRows(owner.registry, "profiles", [], row => row.id)
    if (invalid === "missing-access") await writeCommunityCollectionRows(owner.registry, "channelMemberships", [...owner.registry.collections.channelMemberships.values()].filter(row => row.channelId !== "post"), row => row.id)
    if (invalid === "missing-parent") await writeCommunityCollectionRows(owner.registry, "channels", [...owner.registry.collections.channels.values()].filter(row => row.id !== "forum"), row => row.id)
    if (invalid === "page-param") data.pageParams = []
    owner.client.setQueryData(key, data)
    if (invalid === "initial-error") {
      owner.client.removeQueries({ queryKey: key, exact: true })
      await owner.client.query({ queryKey: key, retry: false, queryFn: async () => { throw new Error("No successful read") } }).catch(() => undefined)
    }
    const next = await saveAndRestore(owner)
    expect(next.client.getQueryData(key)).toBeUndefined()
  })

  it("retains the actual anchor key and page parameter without borrowing preview membership", async () => {
    const owner = await seed(), { key, packet } = await seedBodyWindow(owner)
    owner.client.removeQueries({ queryKey: key })
    const anchorKey = communityKeys.channelMessagesWindow("post", { mode: "anchor", anchor: "read-2" }, "tag")
    owner.client.setQueryData(anchorKey, { pages: [messageWindowPage({ ...packet.page, olderCursor: "before", newerCursor: "after", hasMoreOlder: true, hasMoreNewer: true, messages: packet.messages })], pageParams: [{ mode: "anchor", anchor: "read-2" }] })
    const next = await saveAndRestore(owner)
    expect(next.client.getQueryData(key)).toBeUndefined()
    expect(next.client.getQueryData<MessageWindowData>(anchorKey)?.pages[0]).toMatchObject({ messages: [{ id: "read-1" }, { id: "read-2" }, { id: "read-3" }], olderCursor: "before", newerCursor: "after" })
    expect(next.client.getQueryData<MessageWindowData>(anchorKey)?.pageParams).toEqual([{ mode: "anchor", anchor: "read-2" }])
  })

  it.each(["post", "forum"])("fences a late saved body after durable %s retirement", async id => {
    const owner = await seed(), { key } = await seedBodyWindow(owner)
    const writer = createIdbPersister(owner.account), current = createIdbPersister(owner.account)
    persisters.push(writer, current)
    const snapshot = { timestamp: Date.now(), buster: PERSIST_BUSTER, clientState: dehydrate(owner.client, { shouldDehydrateQuery: shouldDehydrateCommunityQuery }) }
    await writer.persistClient(snapshot)
    await current.retireChannels([id], true)
    await writer.persistClient(snapshot)
    const saved = await current.restoreClient()
    expect(saved?.clientState.queries.some(query => JSON.stringify(query.queryKey) === JSON.stringify(key))).toBe(false)
  })
})

it("retains twenty actual conversation scopes while preview dependencies remain separate", async () => {
  const owner = await seed()
  const channels = Array.from({ length: 21 }, (_, i) => channelResourceFixture({ id: `scope-${i}`, type: "dm", serverId: null, creatorId: owner.account }))
  const messages = channels.map((channel, i) => messageResourceFixture({ id: `scope-message-${i}`, channelId: channel.id, seq: 1, authorId: "peer" }))
  await publishCommunityResourceBundle(owner.client, fullResourceBundleFixture(owner.account, [], channels, messages,
    [profileResourceFixture({ id: owner.account }), profileResourceFixture({ id: "peer" })]), { token: captureCommunityLiveSnapshotToken(owner.client) })
  const now = Date.now()
  channels.forEach((channel, i) => owner.client.setQueryData(communityKeys.channelMessages(channel.id), {
    pages: [messageWindowPage({ messages: [messages[i]], hasMoreOlder: false, hasMoreNewer: false, latestSeq: 1 })], pageParams: [{ mode: "newest" }],
  }, { updatedAt: now + i + 1 }))
  const next = await saveAndRestore(owner)
  expect(next.client.getQueryData(communityKeys.channelMessages("scope-0"))).toBeUndefined()
  for (let i = 1; i <= 20; i++) expect(next.client.getQueryData<MessageWindowData>(communityKeys.channelMessages(`scope-${i}`))?.pages[0].messages.map(row => row.id)).toEqual([`scope-message-${i}`])
  expect(next.registry.collections.messages.get("body")?.content).toBe("Saved first body")
  expect(next.client.getQueryData(communityKeys.channelMessages("post"))).toBeUndefined()
  expect(next.client.getQueryData(keys[0])).toBeDefined()
})

it("does not restore an actual reconnect delta as a display window", async () => {
  const owner = await seed(), { key } = await seedBodyWindow(owner)
  const data = owner.client.getQueryData(key)
  owner.client.removeQueries({ queryKey: key })
  const deltaKey = communityKeys.channelMessagesWindow("post", { mode: "since", since: "cursor" })
  owner.client.setQueryData(deltaKey, data)
  const next = await saveAndRestore(owner)
  expect(next.client.getQueryData(key)).toBeUndefined()
  expect(next.client.getQueryData(deltaKey)).toBeUndefined()
  expect(next.registry.collections.messages.get("body")?.content).toBe("Saved first body")
})
