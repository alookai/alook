import { beforeEach, describe, expect, it, vi } from "vitest"
import { COMMUNITY_CONTRACT_HEADER, COMMUNITY_CONVERSATION_ANCHOR_MISSING, type CommunityConversationEntryRead } from "@alook/shared"
import { ApiError } from "@/lib/errors"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { communityKeys } from "@/lib/query-keys"
import { captureCommunityLiveSnapshotToken, projectCommunityWsEventToDb, publishCommunityLiveSnapshot } from "@/lib/community-db/sync"
import { retireCommunityAccount } from "./account-cache-lifecycle"
import { conversationEntryOptions, currentConversationReadState, findConversationEntryWindow, publishConversationEntry } from "./conversation-entry"
import type { MessageWindowData } from "./message-window"

const load = vi.hoisted(() => vi.fn())
vi.mock("@/lib/api/client", async (original) => ({ ...await original<typeof import("@/lib/api/client")>(), apiFetch: (...args: unknown[]) => load(...args) }))
beforeEach(() => { load.mockReset() })

import { conversationEntryFixture as entry, conversationEntryTarget as target, dmConversationEntryFixture, forumConversationEntryFixture } from "@/test/conversation-entry-fixtures"

describe("conversation entry canonical publication", () => {
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
    expect(registry.collections.channels.get("t1")).toMatchObject({ parentChannelId: "c1", resourceComplete: true })
    expect(client.getQueryCache().findAll({ queryKey: communityKeys.channelMessages("c1") })).toHaveLength(0)
    await client.query({ ...conversationEntryOptions(client, target), select: undefined })
    expect(load).toHaveBeenCalledOnce()
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
    publishCommunityLiveSnapshot(client, { snapshot: { kind: "dms", data: { conversations: [{ id: "dm", userId: "peer", name: "Peer", discriminator: "0042", avatar: "P", avatarVersion: 0, status: "offline", preview: "" }] } }, proof: { kind: "structural", token: captureCommunityLiveSnapshotToken(client), signal: undefined } })
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
      authenticationAccount: "viewer", signal: expect.any(AbortSignal), headers: { [COMMUNITY_CONTRACT_HEADER]: "3" },
    }))
    expect(registry.collections.channels.get("c1")).toMatchObject({ resourceComplete: true, name: "Channel" })
    expect(registry.collections.messages.get("m1")).toMatchObject({ resourceComplete: true, content: "Body" })
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
    const { client } = await createCommunityQueryOwner()
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
    expect(registry.collections.channels.get("c1")?.resourceComplete).toBe(true)
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
