import { canonicalRegistry, capturedOnMessage, capturedQueryClient, cleanupCommunityWsHarness, getCommunityApiFetchMock, hasCanonicalChannelNotify,
  mountCanonicalHook, mountHook, resetCommunityWsHarness, seedCanonicalForumSidebar } from "./test-harness"
import { act } from "@/test/react-dom-harness"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { deriveCommunityDeliveryOperationId, encodeCommunityBrowserEventBatchForContract, prepareCommunityDeliveryEvents, type CommunityWsEvent } from "@alook/shared"
import { captureCommunityLiveSnapshotToken, getCanonicalCommunityChannels, getCanonicalCommunityMessages, publishCommunityChannelMetadata } from "@/lib/community-db/sync"
import { useForumSidebarThreads, type SidebarThreadEnvelope } from "../use-forum-sidebar-threads"
import { communityKeys } from "@/lib/query-keys"

beforeEach(resetCommunityWsHarness)
afterEach(cleanupCommunityWsHarness)
const serverId = "live-server"
function envelope(ids: string[]): SidebarThreadEnvelope {
  const now = new Date().toISOString()
  return { serverNow: now, channels: ids.map(id => ({ id, name: id, serverId, type: "thread", creatorId: "u_me", archived: false,
    parentChannelId: "forum_1", parentMessageId: `opener-${id}`, lastMessageAt: now, activityAt: now,
    expiresAt: new Date(Date.parse(now) + 72 * 60 * 60 * 1000).toISOString(), unread: false })),
    included: { parentMessages: ids.map(id => ({ id: `opener-${id}`, channelId: "forum_1", type: "chat", content: `Title ${id}`, seq: 1 })) } }
}

async function frame(events: CommunityWsEvent[], id: string) {
  const prepared = await prepareCommunityDeliveryEvents(events)
  if (!prepared.ok) throw new Error("invalid live window fixture")
  const encoded = await encodeCommunityBrowserEventBatchForContract({ operationId: await deriveCommunityDeliveryOperationId(id), prepared: prepared.prepared, contract: 2 })
  if (!encoded.ok) throw new Error("invalid live window wire")
  expect(encoded.batch.type).toBe("community:events.batch.v2")
  return encoded.batch
}

describe("live forum window participation convergence", () => {
  it.each([
    { signal: "batch", participates: true, retires: false }, { signal: "message", participates: true, retires: false },
    { signal: "create", participates: true, retires: false }, { signal: "activity", participates: true, retires: false },
    { signal: "batch", participates: false, retires: false }, { signal: "membership", participates: true, retires: false },
    { signal: "batch", participates: true, retires: true },
  ])("confirms $signal participation through the same window resource (eligible=$participates, retired=$retires)", async ({ signal, participates, retires }) => {
    await mountHook({ viewerUserId: "u_me" })
    seedCanonicalForumSidebar(serverId)
    const api = getCommunityApiFetchMock()
    const original = api.getMockImplementation()!
    let reads = 0
    let release!: (value: SidebarThreadEnvelope) => void
    api.mockImplementation((...args: unknown[]) => {
      if (String(args[0]).startsWith(`/api/community/servers/${serverId}/channels?`)) {
        reads++
        return reads === 1 ? Promise.resolve(envelope(["post_1"])) : new Promise<SidebarThreadEnvelope>(resolve => { release = resolve })
      }
      return original(...args)
    })
    const sidebar = await mountCanonicalHook(() => useForumSidebarThreads(serverId, null))
    await expect.poll(() => sidebar.result.current.error?.message ?? sidebar.result.current.sidebar.status).toBe("ready")
    expect(reads).toBe(1)
    act(() => { publishCommunityChannelMetadata(capturedQueryClient, { metadata: {
      id: "post_live", serverId, name: "New live post", type: "thread", parentChannelId: "forum_1", parentMessageId: "opener-post_live",
      creatorId: "u_me", archived: false, lastMessageAt: new Date().toISOString(),
    }, proof: { token: captureCommunityLiveSnapshotToken(capturedQueryClient), signal: undefined } }) })
    expect(hasCanonicalChannelNotify("post_live", "u_me")).toBe(false)
    const now = new Date().toISOString()
    const message: CommunityWsEvent = { type: "community:message.create", serverId, channelId: "post_live", parentChannelId: "forum_1",
      message: { id: "live-reply", type: "chat", authorId: "u_me", authorName: "Me", authorAvatarVersion: 0, content: "First reply", seq: 1, createdAt: now } }
    const create: CommunityWsEvent = { type: "community:channel.child_create", parentChannelId: "forum_1", parentMessageId: "opener-post_live",
      channel: { id: "post_live", name: "New live post", type: "thread", creatorId: "u_me", createdAt: now } }
    const activity: CommunityWsEvent = { type: "community:channel.child_update", parentChannelId: "forum_1", channelId: "post_live", changes: { lastMessageAt: now, messageCount: 1 } }
    const membership: CommunityWsEvent = { type: "community:channel.membership.change", relation: "notify", present: true,
      serverId, channelId: "post_live", userId: "u_me" }
    const events = signal === "membership" ? [message, activity, membership] : signal === "batch" ? [message, activity] : signal === "message" ? [message] : signal === "create" ? [create] : [activity]
    const delivery = await frame(events, `live-${signal}-${participates}`)
    await act(async () => { await capturedOnMessage!(delivery) })
    expect(getCanonicalCommunityChannels(capturedQueryClient).some(row => row.id === "post_live")).toBe(true)
    if (signal === "batch" || signal === "message") expect(getCanonicalCommunityMessages(capturedQueryClient).some(row => row.id === "live-reply")).toBe(true)
    await expect.poll(() => reads).toBe(2)
    expect(hasCanonicalChannelNotify("post_live", "u_me")).toBe(signal === "membership")
    if (signal !== "membership") expect(sidebar.result.current.threads.some(row => row.id === "post_live")).toBe(false)
    const previousWindow = capturedQueryClient.getQueryData(communityKeys.forumSidebarThreads(serverId))
    if (retires) act(() => { canonicalRegistry!.runtime.lifecycle.setState(state => ({ active: false, generation: state.generation + 1 })) })
    await act(async () => { release(envelope(participates ? ["post_1", "post_live"] : ["post_1"])) })
    if (retires) {
      await expect.poll(() => capturedQueryClient.getQueryState(communityKeys.forumSidebarThreads(serverId))?.fetchStatus).toBe("idle")
      expect(hasCanonicalChannelNotify("post_live", "u_me")).toBe(false)
      expect(capturedQueryClient.getQueryData(communityKeys.forumSidebarThreads(serverId))).toBe(previousWindow)
      return
    }
    await expect.poll(() => sidebar.result.current.threads.some(row => row.id === "post_live")).toBe(participates)
    expect(hasCanonicalChannelNotify("post_live", "u_me")).toBe(participates)
    expect(capturedQueryClient.getQueryData(communityKeys.forumSidebarThreads(serverId))).toMatchObject({ window: {
      base: participates ? expect.arrayContaining([expect.objectContaining({ id: "post_live" })]) : [expect.objectContaining({ id: "post_1" })],
    } })
    await act(async () => { await capturedOnMessage!(delivery) })
    expect(reads).toBe(2)
  })
})
