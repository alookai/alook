import React from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClientProvider } from "@tanstack/react-query"
import type { ApiRequestOptions } from "@/lib/api/client"
import { BUSINESS_SCHEMA_VERSION, type CommunityWsEvent } from "@alook/shared"
import { act, renderHook, waitFor } from "@/test/react-dom-harness"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { conversationEntryFixture, conversationEntryFromChannel, seedConversationEntry } from "@/test/conversation-entry-fixtures"
import { CommunityDbProvider } from "@/lib/community-db/projections"
import { retireCommunityAccount } from "@/lib/community/account-cache-lifecycle"
import { captureCommunityLiveSnapshotToken, projectCommunityWsEventToDb, publishCommunityCreatedChannel } from "@/lib/community-db/sync"
import { useChannelMetadata } from "@/hooks/community/use-channel-metadata"
import { buildChannelRouteModel } from "@/hooks/community/use-channel-route-model"

const load = vi.hoisted(() => vi.fn())
vi.mock("@/lib/api/client", async original => ({ ...await original<typeof import("@/lib/api/client")>(), apiFetch: async (path: string, options?: ApiRequestOptions) => { options?.assertActive?.(); return load(path, options) } }))
beforeEach(() => { load.mockReset() })

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

describe("empty thread full identity across current child-create ordering", () => {
  it.each(["before", "pending", "after", "pending-absent", "full-pending", "revoke", "retire"] as const)("handles child-create order %s without stale publication", async timing => {
    const owner = await createCommunityQueryOwner()
    const parent = conversationEntryFixture()
    await seedConversationEntry(owner.client, parent)
    const entry = conversationEntryFromChannel({ ...parent.channel, id: "t1", type: "thread", parentChannelId: "c1", parentMessageId: "m1", name: "Entry thread", lastMessageAt: null })
    entry.channel.messageCount = 0
    entry.parent = parent.channel
    entry.opener = parent.messages[0]
    entry.profiles = parent.profiles
    if (timing !== "pending-absent") publishCommunityCreatedChannel(owner.client, { ...entry.channel, name: "Created thread", creatorId: "viewer", messageCount: 0 }, { token: captureCommunityLiveSnapshotToken(owner.client, "t1") })
    const event = () => projectCommunityWsEventToDb(owner.client, { type: "community:channel.child_create", parentChannelId: "c1", parentMessageId: "m1", channel: timing === "full-pending" ? { ...entry.channel, name: "Event thread", topic: "Event topic", messageCount: 7 } : { ...entry.channel, name: "Event thread", creatorId: "viewer" } } as CommunityWsEvent, BUSINESS_SCHEMA_VERSION)
    if (timing === "before") event()
    const pending = deferred<typeof entry>()
    load.mockReturnValue(pending.promise)
    const wrapper = ({ children }: React.PropsWithChildren) => <QueryClientProvider client={owner.client}><CommunityDbProvider registry={owner.registry}>{children}</CommunityDbProvider></QueryClientProvider>
    const hook = renderHook(() => useChannelMetadata("s1", "t1"), { wrapper })
    await waitFor(() => expect(load).toHaveBeenCalledOnce())
    expect(hook.result.current.canRead).toBe(timing !== "pending-absent")
    if (["pending", "pending-absent", "full-pending", "revoke", "retire"].includes(timing)) await act(async () => { event() })
    if (timing === "revoke") await act(async () => { owner.runtime.ws.actions.revokeChannelAccess("s1", "t1") })
    if (timing === "retire") await act(async () => { retireCommunityAccount(owner.registry) })
    await act(async () => { pending.resolve(entry) })
    await waitFor(() => expect(hook.result.current.isFetching).toBe(false))
    if (timing === "revoke" || timing === "retire") {
      expect(hook.result.current.canRead).toBe(false)
      expect(hook.result.current.identityKnown).toBe(false)
      expect(hook.result.current.data).toBeUndefined()
      expect(load).toHaveBeenCalledOnce()
      hook.unmount()
      return
    }
    expect(hook.result.current.canRead).toBe(true)
    if (timing === "after") await act(async () => { event() })
    const state = hook.result.current
    const identity = state.data
    const meta = identity?.type === "thread" && identity.parentChannelId && identity.parentMessageId ? { ...identity, serverId: "s1", parentChannelId: identity.parentChannelId, parentMessageId: identity.parentMessageId, activityAt: identity.lastMessageAt ?? identity.createdAt } : null
    const model = buildChannelRouteModel({ id: "s1", categories: [] } as never, meta, "t1", { channelId: "t1", settled: state.canRead }, identity, owner.registry.collections.channels.get("c1"))
    expect(state.identityKnown).toBe(true)
    expect(identity).toMatchObject({ id: "t1", type: "thread", parentChannelId: "c1", parentMessageId: "m1", name: timing === "before" ? "Entry thread" : "Event thread" })
    expect(identity).toMatchObject({ topic: timing === "full-pending" ? "Event topic" : "", messageCount: timing === "full-pending" ? 7 : 0 })
    expect(model.routeHydrated).toBe(true)
    expect(load).toHaveBeenCalledOnce()
    hook.unmount()
  })

  it.each([
    [true, false], [false, false], [true, true], [false, true],
  ] as const)("rejects incomplete child resources with known=%s explicit=%s", async (known, explicit) => {
    const owner = await createCommunityQueryOwner()
    const parent = conversationEntryFixture()
    await seedConversationEntry(owner.client, parent)
    const entry = conversationEntryFromChannel({ ...parent.channel, id: "t1", type: "thread", parentChannelId: "c1", parentMessageId: "m1", name: "Entry thread", creatorId: "entry-creator", lastMessageAt: null })
    entry.channel.messageCount = 0
    entry.parent = parent.channel
    entry.opener = parent.messages[0]
    entry.profiles = parent.profiles
    if (known) publishCommunityCreatedChannel(owner.client, { ...entry.channel, name: "Created thread", creatorId: "existing-creator", messageCount: 0 }, { token: captureCommunityLiveSnapshotToken(owner.client, "t1") })
    const pending = deferred<typeof entry>()
    load.mockReturnValue(pending.promise)
    const wrapper = ({ children }: React.PropsWithChildren) => <QueryClientProvider client={owner.client}><CommunityDbProvider registry={owner.registry}>{children}</CommunityDbProvider></QueryClientProvider>
    const hook = renderHook(() => useChannelMetadata("s1", "t1"), { wrapper })
    await waitFor(() => expect(load).toHaveBeenCalledOnce())
    await act(async () => { expect(() => projectCommunityWsEventToDb(owner.client, { type: "community:channel.child_create", parentChannelId: "c1", parentMessageId: "m1", channel: { id: "t1", type: "thread", name: "Event thread", createdAt: entry.channel.createdAt, ...(explicit ? { creatorId: "event-creator" } : {}) } } as CommunityWsEvent, BUSINESS_SCHEMA_VERSION)).toThrow() })
    const during = owner.registry.collections.channels.get("t1")
    const duringCreator = during?.creatorId
    expect(hook.result.current.canRead).toBe(known)
    await act(async () => { pending.resolve(entry) })
    await waitFor(() => expect(hook.result.current.identityKnown).toBe(true))
    expect(duringCreator).toBe(known ? "existing-creator" : undefined)
    expect(hook.result.current.data).toMatchObject({ creatorId: "entry-creator", name: "Entry thread" })
    expect(hook.result.current.canRead).toBe(true)
    expect(load).toHaveBeenCalledOnce()
    hook.unmount()
  })

})
