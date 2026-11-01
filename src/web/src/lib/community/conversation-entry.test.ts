import { dmListRowFixture, channelResourceFixture, profileResourceFixture } from "@/test/community-resource-fixtures"
import { writeCommunityCollectionRows } from "@/lib/community-db/write"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { BUSINESS_SCHEMA_VERSION, COMMUNITY_CONTRACT_HEADER, COMMUNITY_CONVERSATION_ANCHOR_MISSING, type CommunityConversationEntryRead } from "@alook/shared"
import { ApiError } from "@/lib/errors"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { communityKeys } from "@/lib/query-keys"
import { captureCommunityLiveSnapshotToken, projectCommunityWsEventToDb, publishCommunityLiveSnapshot } from "@/lib/community-db/sync"
import { retireCommunityAccount } from "./account-cache-lifecycle"
import { assessConversationScope, conversationEntryOptions, currentConversationReadState, findConversationDisplayWindow, findConversationEntryWindow, getQualifiedConversationScope, publishConversationEntry } from "./conversation-entry"
import type { ChannelRow } from "@/lib/community-db/schema"
import type { MessageWindowData } from "./message-window"
import { configureTelemetry, installTelemetrySink, retireTelemetry } from "@/lib/observability/telemetry"

const load = vi.hoisted(() => vi.fn())
vi.mock("@/lib/api/client", async (original) => ({ ...await original<typeof import("@/lib/api/client")>(), apiFetch: (...args: unknown[]) => load(...args) }))
beforeEach(() => { load.mockReset() })

import { conversationEntryFixture as entry, conversationEntryTarget as target, dmConversationEntryFixture, forumConversationEntryFixture } from "@/test/conversation-entry-fixtures"

describe("conversation entry canonical publication", () => {
  it("does not backfill entry phases when observation becomes eligible after that request began", async () => {
    const { client } = await createCommunityQueryOwner()
    const events: Array<{ name: string }> = []
    let resolve!: (value: CommunityConversationEntryRead) => void
    configureTelemetry({}, false)
    load.mockReturnValue(new Promise<CommunityConversationEntryRead>(done => { resolve = done }))
    try {
      const pending = client.query(conversationEntryOptions(client, target))
      configureTelemetry({ session_id: "current" }, true)
      installTelemetrySink(event => events.push(event))
      resolve(entry())
      await pending
      expect(events.filter(event => event.name === "conversation.entry")).toEqual([])
    } finally { retireTelemetry() }
  })

  it("preserves a qualified window after actual native Query garbage collection removes its entry", async () => {
    vi.useFakeTimers()
    try {
      const { client } = await createCommunityQueryOwner()
      load.mockResolvedValue(entry())
      const options = { ...conversationEntryOptions(client, target), gcTime: 1 }
      const resource = await client.query(options)
      const window = client.getQueryData(resource.windowKey)
      await vi.advanceTimersByTimeAsync(2)
      expect(client.getQueryData(options.queryKey)).toBeUndefined()
      expect(client.getQueryData(resource.windowKey)).toBe(window)
      const scope = getQualifiedConversationScope(client, target)!
      expect(findConversationEntryWindow(client, target, scope, currentConversationReadState(client, "c1"))?.key).toEqual(resource.windowKey)
    } finally { vi.useRealTimers() }
  })

  it.each(["missing", "pending", "archived", "foreign", "parent-missing", "parent-foreign", "retired"] as const)("rejects a %s cache closure without deleting its retained message window", async condition => {
    const { client, registry } = await createCommunityQueryOwner()
    const value = entry()
    if (condition.startsWith("parent")) {
      value.channel = { ...value.channel, type: "thread", parentChannelId: "parent", parentMessageId: "opener" }
      value.parent = { ...entry().channel, id: "parent" }
      value.surfaceReceipt = { channelId: "c1", surfaceKind: "thread" }
    }
    const resource = publishConversationEntry(client, target, value, { token: captureCommunityLiveSnapshotToken(client, "c1") })
    const before = client.getQueryData(resource.windowKey)
    const channels = communityKeys.communityDbCollection("viewer", "channels")
    if (condition === "retired") registry.runtime.lifecycle.setState(state => ({ active: false, generation: state.generation + 1 }))
    else await writeCommunityCollectionRows(registry, "channels", (client.getQueryData<ChannelRow[]>(channels) ?? []).flatMap(row => {
      if (condition === "missing" && row.id === "c1" || condition === "parent-missing" && row.id === "parent") return []
      if (row.id === "c1") return [{ ...row, ...(condition === "pending" ? { pending: true } : {}), ...(condition === "archived" ? { archived: true } : {}),
        ...(condition === "foreign" ? { serverId: "foreign" } : {}) }]
      return [{ ...row, ...(condition === "parent-foreign" ? { serverId: "foreign" } : {}) }]
    }), row => row.id)
    expect(getQualifiedConversationScope(client, target)).toBeUndefined()
    expect(assessConversationScope(client, target).reason).not.toBe("qualified")
    expect(client.getQueryData(resource.windowKey)).toBe(before)
  })

  it("cancels an entry before response delivery and refuses an ignored-abort late body", async () => {
    const { client, registry } = await createCommunityQueryOwner()
    let resolve!: (value: CommunityConversationEntryRead) => void
    load.mockReturnValue(new Promise<CommunityConversationEntryRead>(done => { resolve = done }))
    const options = conversationEntryOptions(client, target)
    const pending = client.query(options).catch(error => error)
    await client.cancelQueries({ queryKey: options.queryKey, exact: true })
    resolve(entry())
    await pending
    await Promise.resolve()
    expect(registry.collections.messages.has("m1")).toBe(false)
    expect(getQualifiedConversationScope(client, target)).toBeUndefined()
  })

  it.each(["text", "dm", "forum", "thread"] as const)("qualifies the canonical %s closure after every short-lived entry is removed", async kind => {
    const { client, registry } = await createCommunityQueryOwner()
    const value = kind === "dm" ? dmConversationEntryFixture() : kind === "forum" ? forumConversationEntryFixture() : entry()
    if (kind === "thread") {
      value.channel = { ...value.channel, type: "thread", parentChannelId: "parent", parentMessageId: "opener" }
      value.parent = { ...entry().channel, id: "parent" }
      value.surfaceReceipt = { channelId: "c1", surfaceKind: "thread" }
    }
    const destination = { channelId: "c1", serverId: value.channel.serverId }
    const options = conversationEntryOptions(client, destination)
    const resource = publishConversationEntry(client, destination, value, { token: captureCommunityLiveSnapshotToken(client, "c1") })
    client.setQueryData(options.queryKey, resource)
    client.removeQueries({ queryKey: communityKeys.conversationEntries("c1") })
    const scope = getQualifiedConversationScope(client, destination)
    expect(scope).toBeDefined()
    expect(scope).not.toHaveProperty("access")
    expect(findConversationDisplayWindow(client, destination, scope!)?.key).toEqual(resource.windowKey)
    expect(findConversationEntryWindow(client, destination, scope!, value.readState)?.key).toEqual(resource.windowKey)
    registry.runtime.ws.actions.revokeChannelAccess(destination.serverId, "c1")
    expect(getQualifiedConversationScope(client, destination)).toBeUndefined()
  })

  it("rejects residual entities without viewer access and retires the same cache on an account change", async () => {
    const { client, registry } = await createCommunityQueryOwner()
    publishConversationEntry(client, target, entry(), { token: captureCommunityLiveSnapshotToken(client, "c1") })
    expect(getQualifiedConversationScope(client, target)).toBeDefined()
    const key = communityKeys.communityDbCollection("viewer", "channelMemberships")
    const rows = client.getQueryData(key)
    await writeCommunityCollectionRows(registry, "channelMemberships", [], (row: { id: string }) => row.id)
    expect(getQualifiedConversationScope(client, target)).toBeUndefined()
    expect(registry.collections.messages.has("m1")).toBe(true)
    client.setQueryData(key, rows)
    registry.runtime.ws.actions.activateProfileAccount("other")
    expect(getQualifiedConversationScope(client, target)).toBeUndefined()
  })

  it("keeps a real cached display window distinct from an uncovered target and an isolated canonical entity", async () => {
    const { client, registry } = await createCommunityQueryOwner()
    const value = entry()
    const resource = publishConversationEntry(client, target, value, { token: captureCommunityLiveSnapshotToken(client, "c1") })
    const scope = getQualifiedConversationScope(client, target)!
    const selected = { ...target, anchorMessageId: "elsewhere" }
    expect(findConversationDisplayWindow(client, selected, scope)?.key).toEqual(resource.windowKey)
    expect(findConversationEntryWindow(client, selected, scope, value.readState)).toBeUndefined()
    client.removeQueries({ queryKey: communityKeys.channelMessages("c1") })
    expect(registry.collections.messages.has("m1")).toBe(true)
    expect(findConversationDisplayWindow(client, target, scope)).toBeUndefined()
  })

  it.each([false, true])("delivers entry while reconciliation is held and preserves its own result after repair failure=%s", async fail => {
    const { client, registry } = await createCommunityQueryOwner()
    const options = conversationEntryOptions(client, target)
    load.mockResolvedValueOnce(entry())
    const previous = await client.query(options)
    const before = client.getQueryData(previous.windowKey)
    const next = entry()
    next.page = { ...next.page, latestSeq: 2, hasMoreNewer: true, newerCursor: "next" }
    let resolve!: (value: unknown) => void
    let reject!: (error: unknown) => void
    const held = new Promise((yes, no) => { resolve = yes; reject = no })
    load.mockImplementation((url: string) => url.includes("entry=1") ? Promise.resolve(next) : held)
    const delivered = await client.query({ ...options, staleTime: 0 })
    const repairKey = [...previous.windowKey, "reconcile"]
    expect(delivered).toMatchObject({ channelId: "c1", readStateRevision: 4 })
    expect(client.getQueryState(options.queryKey)?.status).toBe("success")
    expect(client.getQueryState(repairKey)?.fetchStatus).toBe("fetching")
    expect(client.getQueryData(previous.windowKey)).toBe(before)
    const repair = client.getQueryCache().find({ queryKey: repairKey, exact: true })!.promise!.catch(error => error)
    if (fail) reject(new Error("held repair failed"))
    else resolve({ profiles: next.profiles, messages: [{ ...next.messages[0], id: "m2", seq: 2 }], latestSeq: 2, hasMoreNewer: false })
    await repair
    expect(client.getQueryState(options.queryKey)?.status).toBe("success")
    expect(client.getQueryState(repairKey)?.status).toBe(fail ? "error" : "success")
    expect(registry.collections.messages.has("m2")).toBe(!fail)
  })

  it("keeps one failed DM verification attempt local until an explicit retry", async () => {
    const { client } = await createCommunityQueryOwner()
    const temporary = new ApiError("temporary", 503)
    const missing = new ApiError("missing", 404)
    load.mockRejectedValueOnce(temporary).mockRejectedValueOnce(missing)
    const options = conversationEntryOptions(client, { channelId: "missing-dm", serverId: null })
    await expect(client.query({ ...options, select: undefined })).rejects.toBe(temporary)
    expect(load).toHaveBeenCalledOnce()
    await expect(client.query({ ...options, select: undefined })).rejects.toBe(missing)
    expect(load).toHaveBeenCalledTimes(2)
  })

  it("publishes and reuses the actual forum window without a second messages or threads body cache", async () => {
    const { client, registry } = await createCommunityQueryOwner()
    load.mockResolvedValue(forumConversationEntryFixture())
    const resource = await client.query({ ...conversationEntryOptions(client, target), select: undefined })
    expect(resource.windowKey).toEqual(communityKeys.forumFeed("c1", null))
    const window = client.getQueryData(resource.windowKey)
    expect(JSON.stringify(window)).not.toContain("Body")
    expect(window).toMatchObject({ pages: [{ threads: [{ id: "t1", openerMessageId: "m1" }] }], pageParams: [null] })
    expect(registry.collections.messages.get("m1")?.content).toBe("Body")
    expect(registry.collections.channels.get("t1")).toMatchObject({ parentChannelId: "c1" })
    expect(client.getQueryCache().findAll({ queryKey: communityKeys.channelMessages("c1") })).toHaveLength(0)
    await client.query({ ...conversationEntryOptions(client, target), select: undefined })
    expect(load).toHaveBeenCalledOnce()
  })

  it.each(["child-missing", "child-type", "child-server", "child-parent", "opener-missing", "opener-channel"] as const)("rejects a cached Forum display window with %s without refreshing its qualification", async invalid => {
    const { client, registry } = await createCommunityQueryOwner()
    const value = forumConversationEntryFixture()
    const resource = publishConversationEntry(client, target, value, { token: captureCommunityLiveSnapshotToken(client, "c1") })
    const scope = getQualifiedConversationScope(client, target)!
    expect(findConversationDisplayWindow(client, target, scope)?.key).toEqual(resource.windowKey)
    if (invalid === "child-missing") await registry.collections.channels.utils.writeDelete("t1")
    else if (invalid.startsWith("child-")) {
      const child = registry.collections.channels.get("t1")!
      await writeCommunityCollectionRows(registry, "channels", Array.from(registry.collections.channels.values()).map(row => row.id === child.id ? { ...row,
        ...(invalid === "child-type" ? { type: "text" as const } : {}),
        ...(invalid === "child-server" ? { serverId: "other" } : {}),
        ...(invalid === "child-parent" ? { parentChannelId: "other" } : {}),
      } : row), row => row.id)
    } else if (invalid === "opener-missing") await registry.collections.messages.utils.writeDelete("m1")
    else {
      const opener = registry.collections.messages.get("m1")!
      await writeCommunityCollectionRows(registry, "messages", Array.from(registry.collections.messages.values()).map(row => row.id === opener.id ? { ...row, channelId: "other" } : row), row => row.id)
    }
    expect(getQualifiedConversationScope(client, target)).toBeDefined()
    expect(findConversationDisplayWindow(client, target, scope)).toBeUndefined()
    expect(load).not.toHaveBeenCalled()
  })
  it.each(["empty-query", "failed-query", "empty-pages", "mismatched-params"] as const)("installs the real first window over %s for text and forum", async state => {
    for (const forum of [false, true]) {
      const { client } = await createCommunityQueryOwner()
      const value = forum ? forumConversationEntryFixture() : entry()
      const key = forum ? communityKeys.forumFeed("c1", null) : communityKeys.channelMessagesWindow("c1", { mode: "anchor", anchor: "m1" })
      client.getQueryCache().build(client, { queryKey: key })
      if (state === "failed-query") await expect(client.query({ queryKey: key, queryFn: () => Promise.reject(new Error("first read failed")), retry: false, select: undefined })).rejects.toThrow("first read failed")
      if (state === "empty-pages") client.setQueryData(key, { pages: [], pageParams: [] })
      if (state === "mismatched-params") client.setQueryData(key, { pages: [forum ? { threads: [] } : { messages: [] }], pageParams: [] })
      const resource = publishConversationEntry(client, target, value, { token: captureCommunityLiveSnapshotToken(client, "c1") })
      expect(client.getQueryData<{ pages: unknown[] }>(key)?.pages).toHaveLength(1)
      expect(findConversationEntryWindow(client, target, resource, value.readState)?.key).toEqual(key)
    }
  })

  it("preserves a valid multipage forum feed and its cursors", async () => {
    const { client } = await createCommunityQueryOwner()
    const key = communityKeys.forumFeed("c1", null)
    const previous = { pages: [{ threads: [], nextCursor: "older" }, { threads: [], nextCursor: null }], pageParams: [null, "older"] }
    client.setQueryData(key, previous)
    const value = forumConversationEntryFixture()
    const resource = publishConversationEntry(client, target, value, { token: captureCommunityLiveSnapshotToken(client, "c1") })
    expect(client.getQueryData(key)).toBe(previous)
    expect(findConversationEntryWindow(client, target, resource, value.readState)?.key).toEqual(key)
  })

  it("publishes a cold DM peer closure without another directory or message body cache", async () => {
    const { client, registry } = await createCommunityQueryOwner()
    load.mockResolvedValue(dmConversationEntryFixture())
    const result = await client.query({ ...conversationEntryOptions(client, { channelId: "c1", serverId: null }), select: undefined })
    expect(registry.collections.channelMemberships.get("c1:peer:access")).toMatchObject({ userId: "peer", relation: "access" })
    expect(registry.collections.profiles.get("peer")).toMatchObject({ name: "Peer", avatarVersion: 5 })
    expect(client.getQueryData(communityKeys.dms())).toBeUndefined()
    const { proof: _proof, ...references } = result
    expect(JSON.stringify(references)).not.toContain('"name":"Peer"')
    expect(load).toHaveBeenCalledOnce()
  })

  it("does not overwrite a newer WS peer name or avatar with the original entry snapshot", async () => {
    const { client, registry } = await createCommunityQueryOwner()
    const token = captureCommunityLiveSnapshotToken(client, "c1")
    const { writeCommunityProfilePatches } = await import("./profile-seed")
    writeCommunityProfilePatches([{ id: "peer", identityAbout: { name: "Current", discriminator: "0042" }, avatar: { avatar: "new-avatar", avatarVersion: 8 } }], registry, { event: true })
    publishConversationEntry(client, { channelId: "c1", serverId: null }, dmConversationEntryFixture(), { token })
    expect(registry.collections.profiles.get("peer")).toMatchObject({ name: "Current", avatar: "new-avatar", avatarVersion: 8 })
  })

  it("keeps a freshly verified DM when an older full directory response omits it", async () => {
    const { client, registry } = await createCommunityQueryOwner()
    const previous = captureCommunityLiveSnapshotToken(client)
    publishConversationEntry(client, { channelId: "c1", serverId: null }, dmConversationEntryFixture(), { token: captureCommunityLiveSnapshotToken(client, "c1") })
    publishCommunityLiveSnapshot(client, { snapshot: { kind: "dms", data: { conversations: [] } }, proof: { kind: "structural", token: previous, signal: undefined } })
    expect(registry.collections.channels.get("c1")).toMatchObject({ type: "dm" })
    expect(registry.collections.channelMemberships.get("c1:peer:access")).toBeDefined()
    publishCommunityLiveSnapshot(client, { snapshot: { kind: "dms", data: { conversations: [] } }, proof: { kind: "structural", token: captureCommunityLiveSnapshotToken(client), signal: undefined } })
    expect(registry.collections.channels.get("c1")).toBeUndefined()
  })

  it("keeps a structural directory from creating a second reading-proof cache", async () => {
    const { client, registry } = await createCommunityQueryOwner()
    publishCommunityLiveSnapshot(client, { snapshot: { kind: "dms", data: { conversations: [dmListRowFixture({ id: "dm", userId: "peer", name: "Peer", discriminator: "0042", avatar: "P", avatarVersion: 0, status: "offline", preview: "" })] } }, proof: { kind: "structural", token: captureCommunityLiveSnapshotToken(client), signal: undefined } })
    expect(registry.collections.channels.has("dm")).toBe(true)
    expect(client.getQueryData(communityKeys.channelMeta(null, "dm"))).toBeUndefined()
    expect(client.getQueryCache().findAll({ queryKey: communityKeys.conversationEntries("dm") })).toEqual([])
  })

  it("loads identity, permission, pointer and first window in one native Query and reuses its qualified result", async () => {
    const { client, registry } = await createCommunityQueryOwner()
    load.mockResolvedValue(entry())
    const resource = await client.query({ ...conversationEntryOptions(client, target), select: undefined })
    expect(load).toHaveBeenCalledOnce()
    expect(load).toHaveBeenCalledWith("/api/community/channels/c1/messages?entry=1", expect.objectContaining({
      authenticationAccount: "viewer", signal: expect.any(AbortSignal), headers: { [COMMUNITY_CONTRACT_HEADER]: String(BUSINESS_SCHEMA_VERSION) },
    }))
    expect(registry.collections.channels.get("c1")).toMatchObject({ name: "Channel" })
    expect(registry.collections.messages.get("m1")).toMatchObject({ content: "Body" })
    expect(registry.collections.readStates.get("c1")).toMatchObject({ lastReadSeq: 1, observedRevision: 4 })
    expect(registry.collections.readStateClock.get("account")).toBeUndefined()
    const window = client.getQueryData<MessageWindowData>(resource.windowKey)!
    expect(window.pageParams).toEqual([{ mode: "anchor", anchor: "m1" }])
    expect(window.pages[0].messages).toEqual([{ id: "m1", seq: 1 }])
    expect(JSON.stringify(window)).not.toContain("Body")
    await client.query({ ...conversationEntryOptions(client, target), select: undefined })
    expect(load).toHaveBeenCalledOnce()
    await expect(client.query({ ...conversationEntryOptions(client, { ...target, serverId: "foreign" }), retry: false, select: undefined })).rejects.toThrow("target mismatch")
    expect(load).toHaveBeenCalledTimes(2)
    load.mockClear()
    registry.runtime.ws.actions.beginChannelMembershipChange("s1", "c1")
    await client.query({ ...conversationEntryOptions(client, target), select: undefined })
    expect(load).toHaveBeenCalledOnce()
  })

  it("keeps the pages and pageParams of an existing matching historical window", async () => {
    const { client, registry } = await createCommunityQueryOwner()
    const { ingestMessages } = await import("@/lib/community-db/sync")
    const { writeCommunityProfilePatches, communityUserProfilePatch } = await import("./profile-seed")
    const value = entry()
    writeCommunityProfilePatches(value.profiles.map(profile => communityUserProfilePatch(profile.id, profile)), registry)
    ingestMessages(registry, "c1", [{ ...value.messages[0], id: "history", seq: 0 }])
    const key = communityKeys.channelMessagesWindow("c1", { mode: "anchor", anchor: "m1" })
    const previous: MessageWindowData = {
      pages: [{ messages: [{ id: "m1", seq: 1 }] }, { messages: [{ id: "history", seq: 0 }] }],
      pageParams: [{ mode: "anchor", anchor: "m1" }, { mode: "older", cursor: "old" }],
    }
    client.setQueryData(key, previous)
    publishConversationEntry(client, target, entry(), { token: captureCommunityLiveSnapshotToken(client, "c1") })
    expect(client.getQueryData(key)).toBe(previous)
  })

  it("keeps an explicit missing anchor local to its window and does not retire readable history", async () => {
    const { client, registry } = await createCommunityQueryOwner()
    publishConversationEntry(client, target, entry(), { token: captureCommunityLiveSnapshotToken(client, "c1") })
    const missing = new ApiError("anchor not found", 404, [COMMUNITY_CONVERSATION_ANCHOR_MISSING])
    load.mockRejectedValue(missing)
    await expect(client.query({ ...conversationEntryOptions(client, { ...target, anchorMessageId: "missing" }), select: undefined })).rejects.toBe(missing)
    expect(load).toHaveBeenCalledOnce()
    expect(registry.runtime.ws.actions.isChannelAccessRevoked("c1", "s1")).toBe(false)
    expect(registry.collections.messages.get("m1")?.content).toBe("Body")
  })

  it.each(["revoke", "delete", "retired-owner"])("rejects a late seed after %s without recapturing permission", async (reason) => {
    const { client, registry } = await createCommunityQueryOwner()
    const original = captureCommunityLiveSnapshotToken(client, "c1")
    if (reason === "retired-owner") retireCommunityAccount(registry)
    else if (reason === "delete") projectCommunityWsEventToDb(client, { type: "community:channel.delete", serverId: "s1", channelId: "c1" })
    else registry.runtime.ws.actions.revokeChannelAccess("s1", "c1")
    expect(() => publishConversationEntry(client, target, entry(), { token: original })).toThrow(expect.objectContaining({ name: "AbortError" }))
    expect(client.getQueryData(communityKeys.channelMeta("s1", "c1"))).toBeUndefined()
    expect(registry.collections.messages.get("m1")).toBeUndefined()
  })

  it("does not publish a decoded response into a replaced entry Query", async () => {
    const { client, registry } = await createCommunityQueryOwner()
    let resolve!: (value: CommunityConversationEntryRead) => void
    load.mockReturnValue(new Promise<CommunityConversationEntryRead>((settle) => { resolve = settle }))
    const options = conversationEntryOptions(client, target)
    const reading = client.query({ ...options, select: undefined }).catch((error: unknown) => error)
    const original = client.getQueryCache().find({ queryKey: options.queryKey, exact: true })!
    client.removeQueries({ queryKey: options.queryKey, exact: true })
    const replacement = client.getQueryCache().build(client, client.defaultQueryOptions(options))
    resolve(entry())
    await reading
    expect(replacement).not.toBe(original)
    expect(replacement.state.data).toBeUndefined()
    expect(registry.collections.messages.get("m1")).toBeUndefined()
  })

  it.each(["viewer", "server", "anchor"])("rejects a mismatched %s before any canonical writes", async (field) => {
    const { client, registry } = await createCommunityQueryOwner()
    const value = entry()
    if (field === "viewer") value.viewerId = "foreign"
    if (field === "server") value.channel.serverId = "foreign"
    const destination = field === "anchor" ? { ...target, anchorMessageId: "explicit" } : target
    expect(() => publishConversationEntry(client, destination, value, { token: captureCommunityLiveSnapshotToken(client, "c1") })).toThrow("target mismatch")
    expect(registry.collections.channels.get("c1")).toBeUndefined()
    expect(registry.collections.messages.get("m1")).toBeUndefined()
  })
  it("reads canonical registry rows and clock after their transport queries are removed", async () => {
    const { client, registry } = await createCommunityQueryOwner()
    const row = { channelId: "c1", lastReadMessageId: "read", lastReadAt: "at", lastReadSeq: 7, observedRevision: 9 }
    registry.collections.readStates.utils.writeUpsert(row)
    client.removeQueries({ queryKey: communityKeys.communityDbCollection(registry.scopeId, "readStates"), exact: true })
    const indexed = registry.collections.readStates.get("c1")
    expect(indexed).toMatchObject(row)
    expect(currentConversationReadState(client, "c1")).toBe(indexed)
    registry.collections.readStateClock.utils.writeUpsert({ id: "account", revision: 9 })
    client.removeQueries({ queryKey: communityKeys.communityDbCollection(registry.scopeId, "readStateClock"), exact: true })
    expect(currentConversationReadState(client, "not-yet-read")).toEqual({ channelId: "not-yet-read", lastReadMessageId: null, lastReadAt: null, lastReadSeq: 0, observedRevision: 9 })
  })

  it("has no current read pointer before either a row or an account clock is known", async () => {
    const { client } = await createCommunityQueryOwner()
    expect(currentConversationReadState(client, "unknown")).toBeUndefined()
  })

  it("finds its canonical window after channel transport query eviction", async () => {
    const { client, registry } = await createCommunityQueryOwner()
    const value = entry()
    const resource = publishConversationEntry(client, target, value, { token: captureCommunityLiveSnapshotToken(client, "c1") })
    client.removeQueries({ queryKey: communityKeys.communityDbCollection(registry.scopeId, "channels"), exact: true })
    expect(registry.collections.channels.get("c1")).toMatchObject(value.channel)
    expect(findConversationEntryWindow(client, target, resource, value.readState)?.key).toEqual(resource.windowKey)
  })

  it("admits a missing read pointer only for its qualified newest window with no newer page", async () => {
    const { client } = await createCommunityQueryOwner()
    const value = entry()
    value.readState = { channelId: "c1", lastReadMessageId: "missing", lastReadAt: "at", lastReadSeq: 10 }
    value.selection = { reason: "read_pointer_missing", anchorMessageId: null }
    const resource = publishConversationEntry(client, target, value, { token: captureCommunityLiveSnapshotToken(client, "c1") })
    expect(findConversationEntryWindow(client, target, resource, value.readState)?.initial).toEqual({ mode: "newest" })
    expect(findConversationEntryWindow(client, target, resource, { ...value.readState, lastReadMessageId: "newer" })).toBeUndefined()
    expect(findConversationEntryWindow(client, { ...target, anchorMessageId: "explicit" }, resource, value.readState)).toBeUndefined()
    const data = client.getQueryData<MessageWindowData>(resource.windowKey)!
    client.setQueryData(resource.windowKey, { ...data, pages: data.pages.map(page => ({ ...page, hasMoreNewer: true })) })
    expect(findConversationEntryWindow(client, target, resource, value.readState)).toBeUndefined()
    client.setQueryData(resource.windowKey, data)
    const historical = communityKeys.channelMessagesWindow("c1", { mode: "anchor", anchor: "elsewhere" })
    client.setQueryData(historical, data)
    client.removeQueries({ queryKey: resource.windowKey, exact: true })
    expect(findConversationEntryWindow(client, target, resource, value.readState)).toBeUndefined()
  })

})


it.each(["main", "opener"] as const)("validates the effective retained %s reply graph before any entry write", async location => {
  const { communityRegistrySnapshot } = await import("@/test/community-registry-snapshot")
  const { ingestMessages } = await import("@/lib/community-db/sync")
  const { communityUserProfilePatch, writeCommunityProfilePatches } = await import("./profile-seed")
  const { client, registry } = await createCommunityQueryOwner()
  const value = entry()
  const original = { ...value.messages[0], ...(location === "opener" ? { id: "opener", channelId: "parent" } : {}) }
  const retainedReply = { id: "prior", authorId: "prior-author", authorName: "Prior author", text: "Retained reply" }
  ingestMessages(registry, original.channelId, [{ ...original, replyToId: "prior", replyTo: retainedReply }])
  const incoming = { ...original, replyToId: "prior" }
  if (location === "main") value.messages = [incoming]
  else {
    value.channel = { ...value.channel, type: "thread", parentChannelId: "parent", parentMessageId: "opener" }
    value.parent = channelResourceFixture({ id: "parent", serverId: "s1", type: "text" })
    value.opener = incoming
    value.surfaceReceipt = { channelId: "c1", surfaceKind: "thread" }
  }
  const before = communityRegistrySnapshot(registry)
  const queries = client.getQueryCache().getAll().map(query => [query.queryKey, structuredClone(query.state.data)])
  const access = structuredClone(registry.runtime.ws.get().channelAccessScopes)
  expect(() => publishConversationEntry(client, target, value, { token: captureCommunityLiveSnapshotToken(client, "c1") })).toThrow("Retained message profile resource missing")
  expect(communityRegistrySnapshot(registry)).toEqual(before)
  expect(registry.runtime.ws.get().channelAccessScopes).toEqual(access)
  expect(client.getQueryCache().getAll().map(query => [query.queryKey, query.state.data])).toEqual(queries)
  const prior = profileResourceFixture({ id: "prior-author", name: "Prior author" })
  writeCommunityProfilePatches([communityUserProfilePatch(prior.id, prior)], registry)
  const resource = publishConversationEntry(client, target, value, { token: captureCommunityLiveSnapshotToken(client, "c1") })
  expect(registry.collections.messages.get(original.id)?.replyTo).toEqual(retainedReply)
  expect(findConversationEntryWindow(client, target, resource, value.readState)).toBeDefined()
})
