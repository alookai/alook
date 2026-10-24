import "fake-indexeddb/auto"
import { afterEach, describe, expect, it } from "vitest"
import { dehydrate, QueryClient } from "@tanstack/react-query"
import { communityKeys } from "@/lib/query-keys"
import { canonicalChannelMembershipRow, canonicalChannelRow, messageSchema, serverSchema } from "@/lib/community-db/schema"
import { forumSidebarWindowComplete, readForumSidebarWindowResult } from "@/lib/community/forum-sidebar-window"
import { clearPersistedCache, createIdbPersister, PERSIST_BUSTER, shouldDehydrateCommunityQuery } from "./query-persister"

const accountId = "window-viewer"
const serverId = "window-server"
const key = communityKeys.forumSidebarThreads(serverId)
const owners: QueryClient[] = []
afterEach(async () => { for (const owner of owners) owner.clear(); owners.length = 0; await clearPersistedCache(accountId) })
function setup(empty = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  owners.push(client)
  const rows = {
    servers: [serverSchema.parse({ id: serverId, name: "Server", discriminator: "0001", description: "", ownerId: accountId,
      icon: null, official: false, isOwner: true, unread: false, mentions: 0, detailComplete: true })],
    channels: [canonicalChannelRow({ id: "forum", type: "forum", serverId }),
      ...empty ? [] : [canonicalChannelRow({ id: "post", type: "thread", serverId, parentChannelId: "forum", parentMessageId: "opener" })]],
    messages: empty ? [] : [messageSchema.parse({ id: "opener", channelId: "forum", type: "chat", content: "Canonical title", seq: 1 })],
    channelMemberships: empty ? [] : [canonicalChannelMembershipRow("post", accountId, "notify")],
  }
  for (const [name, data] of Object.entries(rows)) client.setQueryData(communityKeys.communityDbCollection(accountId, name), data)
  const result = {
    threads: [{ id: "duplicated-entity", title: "Must not persist" }], verifiedEpoch: 99,
    serverNow: new Date().toISOString(), serverClockOffsetMs: 0,
    window: { version: 1 as const, accountId, serverId, parents: ["forum"],
      base: empty ? [] : [{ id: "post", parentChannelId: "forum", parentMessageId: "opener" }], retained: null },
  }
  client.setQueryData(key, result)
  const snapshot = () => ({ timestamp: Date.now(), buster: PERSIST_BUSTER, clientState: dehydrate(client, { shouldDehydrateQuery: shouldDehydrateCommunityQuery }) })
  return { client, rows, result, snapshot }
}

describe("scoped forum window persistence", () => {
  it.each([false, true])("restores only a complete minimal %s window without entity copies or access proof", async empty => {
    const owner = setup(empty)
    const persister = createIdbPersister(accountId)
    await persister.persistClient(owner.snapshot())
    const restored = await persister.restoreClient()
    const state = restored!.clientState.queries.find(query => JSON.stringify(query.queryKey) === JSON.stringify(key))!.state
    expect(state).toMatchObject({ status: "success", error: null, fetchStatus: "idle", isInvalidated: true,
      data: { threads: [], verifiedEpoch: -1, window: owner.result.window } })
    expect(JSON.stringify(state.data)).not.toContain("Canonical title")
    expect(JSON.stringify(state.data)).not.toContain("Must not persist")
    expect(forumSidebarWindowComplete(readForumSidebarWindowResult(state.data)!.window, owner.rows, accountId, serverId)).toBe(true)
  })

  it.each(["messages", "channelMemberships", "parent", "server", "detail"])("rejects a descriptor with missing %s before hydrate", async missing => {
    const owner = setup()
    if (missing === "parent") owner.client.setQueryData(communityKeys.communityDbCollection(accountId, "channels"), owner.rows.channels.filter(row => row.id !== "forum"))
    else if (missing === "server") owner.client.setQueryData(communityKeys.communityDbCollection(accountId, "servers"), [])
    else if (missing === "detail") owner.client.setQueryData(communityKeys.communityDbCollection(accountId, "servers"), owner.rows.servers.map(row => ({ ...row, detailComplete: false })))
    else owner.client.setQueryData(communityKeys.communityDbCollection(accountId, missing), [])
    const persister = createIdbPersister(accountId)
    await persister.persistClient(owner.snapshot())
    expect((await persister.restoreClient())!.clientState.queries.some(query => JSON.stringify(query.queryKey) === JSON.stringify(key))).toBe(false)
  })

  it.each(["account", "server", "legacy", "version", "unbounded"])("rejects a %s window", async invalid => {
    const owner = setup()
    const result = structuredClone(owner.result)
    if (invalid === "account") result.window.accountId = "other-viewer"
    if (invalid === "server") result.window.serverId = "other-server"
    if (invalid === "legacy") Reflect.deleteProperty(result, "window")
    if (invalid === "version") Reflect.set(result.window, "version", 0)
    if (invalid === "unbounded") result.window.base = Array.from({ length: 6 }, (_, index) => ({ id: `post-${index}`, parentChannelId: "forum", parentMessageId: "opener" }))
    owner.client.setQueryData(key, result)
    const persister = createIdbPersister(accountId)
    await persister.persistClient(owner.snapshot())
    expect((await persister.restoreClient())!.clientState.queries.some(query => JSON.stringify(query.queryKey) === JSON.stringify(key))).toBe(false)
  })

  it.each([false, true])("fences a late writer's %s window after post or parent retirement", async empty => {
    const owner = setup(empty)
    const stale = createIdbPersister(accountId)
    const before = owner.snapshot()
    await stale.persistClient(before)
    const current = createIdbPersister(accountId)
    await current.retireChannels([empty ? "forum" : "post"], true)
    await stale.persistClient(before)
    expect((await current.restoreClient())!.clientState.queries.some(query => JSON.stringify(query.queryKey) === JSON.stringify(key))).toBe(false)
  })

  it("does not admit an initial error or broaden persistence for other failed resources", async () => {
    const owner = setup()
    owner.client.removeQueries({ queryKey: key, exact: true })
    await owner.client.query({ queryKey: key, queryFn: () => Promise.reject(new Error("Initial failure")) }).catch(() => undefined)
    const machines = communityKeys.machines()
    owner.client.setQueryData(machines, { machines: [] })
    await owner.client.query({ queryKey: machines, queryFn: () => Promise.reject(new Error("Machine refresh failure")), staleTime: 0 }).catch(() => undefined)
    expect(owner.snapshot().clientState.queries.some(query => JSON.stringify(query.queryKey) === JSON.stringify(key))).toBe(false)
    expect(owner.snapshot().clientState.queries.some(query => JSON.stringify(query.queryKey) === JSON.stringify(machines))).toBe(false)
  })

  it("checks a realtime visible child closure even when the last successful base was empty", async () => {
    const owner = setup(true)
    owner.client.setQueryData(communityKeys.communityDbCollection(accountId, "channels"), [
      ...owner.rows.channels, canonicalChannelRow({ id: "realtime-post", type: "thread", serverId, parentChannelId: "forum", parentMessageId: "missing-opener", lastMessageAt: new Date().toISOString() }),
    ])
    owner.client.setQueryData(communityKeys.communityDbCollection(accountId, "channelMemberships"), [canonicalChannelMembershipRow("realtime-post", accountId, "notify")])
    const persister = createIdbPersister(accountId)
    await persister.persistClient(owner.snapshot())
    expect((await persister.restoreClient())!.clientState.queries.some(query => JSON.stringify(query.queryKey) === JSON.stringify(key))).toBe(false)
  })

  it("binds retained disposition to its child while keeping the base window reusable", () => {
    const owner = setup()
    const result = readForumSidebarWindowResult(owner.result)!
    const window = { ...result.window, retained: { id: "archived-child", disposition: "opener-archived" as const } }
    expect(forumSidebarWindowComplete(window, owner.rows, accountId, serverId, "archived-child")).toBe(true)
    expect(forumSidebarWindowComplete(window, owner.rows, accountId, serverId, "other-child")).toBe(false)
    expect(forumSidebarWindowComplete(window, owner.rows, accountId, serverId, null)).toBe(true)
  })
})
