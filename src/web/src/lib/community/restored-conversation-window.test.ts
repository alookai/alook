import { dehydrate } from "@tanstack/react-query"
import "fake-indexeddb/auto"
import { afterEach, expect, it, vi } from "vitest"
import { COMMUNITY_CONTRACT_HEADER, COMMUNITY_CONTRACT_VERSION } from "@alook/shared"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { conversationEntryFixture, dmConversationEntryFixture, seedConversationEntry } from "@/test/conversation-entry-fixtures"
import { profileResourceFixture, serverResourceFixture } from "@/test/community-resource-fixtures"
import { clearPersistedCache, createCommunityRestorePersister, createIdbPersister, MAX_PERSISTED_MESSAGES_PER_SCOPE, PERSIST_BUSTER, PERSIST_MAX_AGE_MS, readCommunityRestoredCollections, shouldDehydrateCommunityQuery } from "@/lib/query-persister"
import { persistQueryClientRestore } from "@tanstack/react-query-persist-client"
import { writeCommunityCollectionRows } from "@/lib/community-db/write"
import { captureCommunityLiveSnapshotToken, discardCommunityRestoreReplacements, publishCommunityMessages, restoreCommunityCollections } from "@/lib/community-db/sync"
import { retireCommunityAccount } from "./account-cache-lifecycle"
import { communityKeys } from "@/lib/query-keys"
import { assessConversationScope, conversationEntryOptions, currentConversationReadState, findConversationEntryWindow } from "./conversation-entry"
import { appendContiguousTailMessageToWindow } from "./message-reconcile"
import type { MessageWindowData } from "./message-window"
import { restoreConversationDisplayWindows } from "./restored-conversation-window"

afterEach(() => vi.restoreAllMocks())

async function setup() {
  const owner = await createCommunityQueryOwner()
  const entry = dmConversationEntryFixture()
  entry.messages = [1, 3, 4].map(seq => ({ ...entry.messages[0], id: `m${seq}`, seq, createdAt: `2026-10-01T00:00:0${seq}.000Z` }))
  entry.page.latestSeq = 4
  await seedConversationEntry(owner.client, entry)
  const input = readCommunityRestoredCollections({ timestamp: Date.now(), buster: PERSIST_BUSTER, clientState: dehydrate(owner.client) }, "viewer")
  const key = communityKeys.channelMessages("c1")
  const networkWindow = owner.client.getQueryData(key)
  owner.client.removeQueries({ queryKey: key })
  owner.client.removeQueries({ queryKey: communityKeys.conversationEntries("c1") })
  owner.registry.bindAuthentication(() => undefined, async () => {})
  return { ...owner, input, key, networkWindow }
}

it("restores saved membership and the older cursor while the latest edge awaits entry", async () => {
  const { registry, client, input, key } = await setup()
  restoreConversationDisplayWindows(registry, input)
  const data = client.getQueryData<MessageWindowData>(key)!
  expect(data.pages[0].messages.map(row => row.id)).toEqual(["m1", "m3", "m4"])
  expect(data.pages[0]).toMatchObject({ hasMoreOlder: true, hasMoreNewer: true, latestSeq: 4,
    olderCursor: "older", newerCursor: "2026-10-01T00:00:04.000Z|m4" })
  const target = { channelId: "c1", serverId: null }
  expect(findConversationEntryWindow(client, target, assessConversationScope(client, target).scope!, currentConversationReadState(client, "c1"))).toBeUndefined()
  expect(() => registry.assertOnlineAccount()).toThrow(expect.objectContaining({ name: "AbortError" }))
})

it("restores a genuine three-message DM with a confirmed start and no older cursor", async () => {
  const { registry, client, input, key } = await setup()
  const saved = input.messageWindows![0].data.pages[0]
  saved.hasMoreOlder = false
  saved.olderCursor = undefined
  restoreConversationDisplayWindows(registry, input)
  const restored = client.getQueryData<MessageWindowData>(key)!.pages[0]
  expect(restored.messages).toHaveLength(3)
  expect(restored.hasMoreOlder).toBe(false)
  expect(restored.olderCursor).toBeUndefined()
})

it("preserves a network window that settled before restoration", async () => {
  const { registry, client, input, key, networkWindow } = await setup()
  client.setQueryData(key, networkWindow)
  restoreConversationDisplayWindows(registry, input)
  expect(client.getQueryData(key)).toBe(networkWindow)
})

it.each(["unchanged tail", "new message"] as const)("confirms an %s through the original request and reconciliation after cached display", async condition => {
  const { registry, client, input, key } = await setup()
  restoreConversationDisplayWindows(registry, input)
  registry.bindAuthentication(() => "viewer", async () => {})
  registry.confirmAuthentication()
  const entry = dmConversationEntryFixture()
  entry.messages = (condition === "new message" ? [1, 3, 4, 5] : [3, 4]).map(seq => ({ ...entry.messages[0], id: seq === 5 ? "fresh" : `m${seq}`, seq, content: seq === 5 ? "Fresh" : "Body", createdAt: `2026-10-01T00:00:0${seq}.000Z` }))
  entry.page.latestSeq = condition === "new message" ? 5 : 4
  const load = vi.spyOn(globalThis, "fetch").mockImplementation(async input => Response.json(
    new URL(String(input), "https://fixture.test").searchParams.has("entry") ? entry : { contractVersion: entry.contractVersion, channelId: entry.channelId, surfaceReceipt: entry.surfaceReceipt, page: entry.page, messages: entry.messages, profiles: entry.profiles },
    { headers: { [COMMUNITY_CONTRACT_HEADER]: String(COMMUNITY_CONTRACT_VERSION) } },
  ))
  await client.query(conversationEntryOptions(client, { channelId: "c1", serverId: null }))
  await client.getQueryCache().find({ queryKey: [...key, "reconcile"], exact: true })?.promise
  await vi.waitFor(() => expect(client.getQueryData<MessageWindowData>(key)?.pages[0].hasMoreNewer).toBe(false))
  if (condition === "new message") expect(registry.collections.messages.get("fresh")?.content).toBe("Fresh")
  expect(findConversationEntryWindow(client, { channelId: "c1", serverId: null }, assessConversationScope(client, { channelId: "c1", serverId: null }).scope!, currentConversationReadState(client, "c1"))).toBeDefined()
  expect(load).toHaveBeenCalled()
})

it("moves a legacy short window's older cursor when the original entry extends it", async () => {
  const { registry, client, input, key } = await setup()
  const saved = input.messageWindows![0].data.pages[0]
  saved.messages = saved.messages.slice(1)
  saved.olderCursor = "2026-10-01T00:00:03.000Z|m3"
  restoreConversationDisplayWindows(registry, input)
  registry.bindAuthentication(() => "viewer", async () => {})
  registry.confirmAuthentication()

  const entry = dmConversationEntryFixture()
  entry.messages = [2, 3, 4].map(seq => ({ ...entry.messages[0], id: `m${seq}`, seq, createdAt: `2026-10-01T00:00:0${seq}.000Z` }))
  const olderCursor = "2026-10-01T00:00:02.000Z|m2"
  entry.page = { ...entry.page, latestSeq: 4, hasMoreOlder: true, olderCursor }
  const load = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(entry, {
    headers: { [COMMUNITY_CONTRACT_HEADER]: String(COMMUNITY_CONTRACT_VERSION) },
  }))
  await client.query(conversationEntryOptions(client, { channelId: "c1", serverId: null }))
  await client.getQueryCache().find({ queryKey: [...key, "reconcile"], exact: true })?.promise
  expect(client.getQueryData<MessageWindowData>(key)?.pages[0]).toMatchObject({
    messages: entry.messages.map(({ id, seq }) => ({ id, seq })), hasMoreOlder: true, olderCursor, hasMoreNewer: false,
  })
  expect(load).toHaveBeenCalledOnce()
  expect(new URL(String(load.mock.calls[0][0]), "https://fixture.test").searchParams.get("entry")).toBe("1")
})

it.each(["other account", "missing access", "revoked", "retired", "missing profile", "missing body"] as const)("cannot create a display window with %s", async condition => {
  const { registry, client, input, key } = await setup()
  if (condition === "other account") registry.bindAuthentication(() => "B", async () => {})
  if (condition === "missing access") await writeCommunityCollectionRows(registry, "channelMemberships", [], row => row.id)
  if (condition === "revoked") registry.runtime.ws.actions.revokeChannelAccess(null, "c1")
  if (condition === "retired") retireCommunityAccount(registry)
  if (condition === "missing profile") await writeCommunityCollectionRows(registry, "profiles", [], row => row.id)
  if (condition === "missing body") await writeCommunityCollectionRows(registry, "messages", [], row => row.id)
  restoreConversationDisplayWindows(registry, input)
  expect(client.getQueryData(key)).toBeUndefined()
})

it.each(["channel", "dm"] as const)("persists and cold-restores contiguous tail messages for %s while rejecting gaps and revoked scopes", async kind => {
  const account = `tail-persist-${kind}-${crypto.randomUUID()}`
  const source = await createCommunityQueryOwner(account)
  const writer = createIdbPersister(account)
  const reader = createIdbPersister(account)
  try {
    const entry = kind === "dm" ? dmConversationEntryFixture() : conversationEntryFixture()
    entry.viewerId = account
    entry.channel = { ...entry.channel, creatorId: account }
    entry.profiles = [
      ...entry.profiles,
      profileResourceFixture({ id: account, name: "Viewer" }),
    ]
    entry.messages = [1, 2].map((seq) => ({
      ...entry.messages[0],
      id: `m${seq}`,
      seq,
      authorId: seq === 1 ? "peer" : account,
      createdAt: `2026-10-01T00:00:0${seq}.000Z`,
    }))
    entry.page = { olderCursor: null, newerCursor: null, hasMoreOlder: false, hasMoreNewer: false, latestSeq: 2 }
    if (kind === "channel") {
      await writeCommunityCollectionRows(
        source.registry,
        "servers",
        [serverResourceFixture({ id: "s1", ownerId: account })],
        (row) => row.id,
      )
    }
    await seedConversationEntry(source.client, entry)

    const contiguous = {
      ...entry.messages[0],
      id: "m3",
      seq: 3,
      authorId: account,
      content: "Sent tail",
      createdAt: "2026-10-01T00:00:03.000Z",
    }
    await publishCommunityMessages(source.client, {
      channelId: "c1",
      messages: [contiguous],
      profiles: entry.profiles,
      proof: { token: captureCommunityLiveSnapshotToken(source.client, "c1") },
    })
    expect(appendContiguousTailMessageToWindow(source.client, "c1", contiguous)).toBe(true)
    // Duplicate append is a no-op.
    expect(appendContiguousTailMessageToWindow(source.client, "c1", contiguous)).toBe(false)

    // Non-contiguous gap (seq 5 when latest is 3) must NOT be spliced.
    const gapped = {
      ...entry.messages[0],
      id: "m5",
      seq: 5,
      authorId: "peer",
      content: "After gap",
      createdAt: "2026-10-01T00:00:05.000Z",
    }
    await publishCommunityMessages(source.client, {
      channelId: "c1",
      messages: [gapped],
      profiles: entry.profiles,
      proof: { token: captureCommunityLiveSnapshotToken(source.client, "c1") },
    })
    expect(appendContiguousTailMessageToWindow(source.client, "c1", gapped)).toBe(false)

    // Revoked scope must reject contiguous seq 4.
    const blocked = {
      ...entry.messages[0],
      id: "m4",
      seq: 4,
      authorId: "peer",
      content: "After revoke",
      createdAt: "2026-10-01T00:00:04.000Z",
    }
    await publishCommunityMessages(source.client, {
      channelId: "c1",
      messages: [blocked],
      profiles: entry.profiles,
      proof: { token: captureCommunityLiveSnapshotToken(source.client, "c1") },
    })
    source.registry.runtime.ws.actions.revokeChannelAccess(entry.channel.serverId, "c1")
    expect(appendContiguousTailMessageToWindow(source.client, "c1", blocked)).toBe(false)
    source.registry.runtime.ws.actions.rememberChannelAccess(entry.channel.serverId, "c1")

    await writer.persistClient({
      timestamp: Date.now(),
      buster: PERSIST_BUSTER,
      clientState: dehydrate(source.client, { shouldDehydrateQuery: shouldDehydrateCommunityQuery }),
    })
    writer.stopPersisting()
    await source.registry.cleanup()
    source.client.clear()

    const next = await createCommunityQueryOwner(account)
    const restore = createCommunityRestorePersister(reader, account)
    await persistQueryClientRestore({
      queryClient: next.client,
      persister: restore.persister,
      buster: PERSIST_BUSTER,
      maxAge: PERSIST_MAX_AGE_MS,
    })
    const input = restore.takeCollections()
    await restoreCommunityCollections(next.registry, input)
    next.registry.captureRestoredCollections(input)
    next.registry.runtime.ws.actions.activateProfileAccount(account)
    discardCommunityRestoreReplacements(next.registry)
    restoreConversationDisplayWindows(next.registry, input)

    const key = communityKeys.channelMessages("c1")
    const restored = next.client.getQueryData<MessageWindowData>(key)!
    expect(restored.pages[0].messages.map((row) => row.id)).toEqual(["m1", "m2", "m3"])
    expect(restored.pages[0].latestSeq).toBe(3)
    expect(restored.pages[0].newestCursor).toBe("2026-10-01T00:00:03.000Z|m3")

    // Reconcile entry=1 after cold restore produces zero duplicates and intact cursors.
    const refreshedEntry = {
      ...entry,
      messages: [...entry.messages, contiguous],
      page: { olderCursor: null, newerCursor: null, hasMoreOlder: false, hasMoreNewer: false, latestSeq: 3 },
    }
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json(refreshedEntry, {
      headers: { [COMMUNITY_CONTRACT_HEADER]: String(COMMUNITY_CONTRACT_VERSION) },
    }))
    await next.client.query(conversationEntryOptions(next.client, { channelId: "c1", serverId: entry.channel.serverId }))
    await next.client.getQueryCache().find({ queryKey: [...key, "reconcile"], exact: true })?.promise
    const settled = next.client.getQueryData<MessageWindowData>(key)!
    expect(settled.pages[0].messages.map((row) => row.id)).toEqual(["m1", "m2", "m3"])
    expect(settled.pages[0].hasMoreNewer).toBe(false)
    expect(settled.pages[0].hasMoreOlder).toBe(false)
    expect(settled.pages[0].newestCursor).toBe("2026-10-01T00:00:03.000Z|m3")
    await next.registry.cleanup()
    next.client.clear()
  } finally {
    writer.stopPersisting()
    reader.stopPersisting()
    await clearPersistedCache(account)
  }
})

it("bounds persisted newest window to MAX_PERSISTED_MESSAGES_PER_SCOPE while retaining the appended tail", async () => {
  const account = `tail-bound-${crypto.randomUUID()}`
  const source = await createCommunityQueryOwner(account)
  const writer = createIdbPersister(account)
  const reader = createIdbPersister(account)
  try {
    const entry = dmConversationEntryFixture()
    entry.viewerId = account
    entry.channel = { ...entry.channel, creatorId: account }
    entry.profiles = [...entry.profiles, profileResourceFixture({ id: account, name: "Viewer" })]
    entry.messages = Array.from({ length: MAX_PERSISTED_MESSAGES_PER_SCOPE }, (_, index) => ({
      ...entry.messages[0],
      id: `m${index + 1}`,
      seq: index + 1,
      authorId: "peer",
      createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, index + 1)).toISOString(),
    }))
    entry.page = {
      olderCursor: null,
      newerCursor: null,
      hasMoreOlder: false,
      hasMoreNewer: false,
      latestSeq: MAX_PERSISTED_MESSAGES_PER_SCOPE,
    }
    await seedConversationEntry(source.client, entry)

    const tailSeq = MAX_PERSISTED_MESSAGES_PER_SCOPE + 1
    const tailMessage = {
      ...entry.messages[0],
      id: `m${tailSeq}`,
      seq: tailSeq,
      authorId: account,
      content: "Newest tail beyond cap",
      createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, tailSeq)).toISOString(),
    }
    await publishCommunityMessages(source.client, {
      channelId: "c1",
      messages: [tailMessage],
      profiles: entry.profiles,
      proof: { token: captureCommunityLiveSnapshotToken(source.client, "c1") },
    })
    expect(appendContiguousTailMessageToWindow(source.client, "c1", tailMessage)).toBe(true)

    await writer.persistClient({
      timestamp: Date.now(),
      buster: PERSIST_BUSTER,
      clientState: dehydrate(source.client, { shouldDehydrateQuery: shouldDehydrateCommunityQuery }),
    })
    writer.stopPersisting()
    await source.registry.cleanup()
    source.client.clear()

    const next = await createCommunityQueryOwner(account)
    const restore = createCommunityRestorePersister(reader, account)
    await persistQueryClientRestore({
      queryClient: next.client,
      persister: restore.persister,
      buster: PERSIST_BUSTER,
      maxAge: PERSIST_MAX_AGE_MS,
    })
    const input = restore.takeCollections()
    await restoreCommunityCollections(next.registry, input)
    next.registry.captureRestoredCollections(input)
    next.registry.runtime.ws.actions.activateProfileAccount(account)
    discardCommunityRestoreReplacements(next.registry)
    restoreConversationDisplayWindows(next.registry, input)

    const restored = next.client.getQueryData<MessageWindowData>(communityKeys.channelMessages("c1"))!
    expect(restored.pages[0].messages).toHaveLength(MAX_PERSISTED_MESSAGES_PER_SCOPE)
    expect(restored.pages[0].messages[0]).toEqual({ id: "m2", seq: 2 })
    expect(restored.pages[0].messages.at(-1)).toEqual({ id: `m${tailSeq}`, seq: tailSeq })
    expect(restored.pages[0].hasMoreOlder).toBe(true)
    expect(restored.pages[0].latestSeq).toBe(tailSeq)
    await next.registry.cleanup()
    next.client.clear()
  } finally {
    writer.stopPersisting()
    reader.stopPersisting()
    await clearPersistedCache(account)
  }
})
