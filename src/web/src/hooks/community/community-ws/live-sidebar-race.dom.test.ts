import { forumSidebarEnvelopeFixture, messageResourceFixture } from "@/test/community-resource-fixtures"
import { capturedOnMessage, capturedQueryClient, cleanupCommunityWsHarness, getCommunityApiFetchMock, hasCanonicalChannelNotify,
  mountCanonicalHook, mountHook, resetCommunityWsHarness, seedCanonicalForumSidebar } from "./test-harness"
import { act } from "@/test/react-dom-harness"
import { afterEach, beforeEach, expect, it } from "vitest"
import { BUSINESS_SCHEMA_VERSION, communityBrowserEventBatchType, deriveCommunityDeliveryOperationId, encodeCommunityBrowserEventBatchForContract, prepareCommunityDeliveryEvents, type CommunityWsEvent } from "@alook/shared"
import { patchCanonicalCommunityChannel } from "@/lib/community-db/sync"
import { useForumSidebarThreads, type SidebarThreadEnvelope } from "../use-forum-sidebar-threads"
import { communityKeys } from "@/lib/query-keys"

beforeEach(resetCommunityWsHarness)
afterEach(cleanupCommunityWsHarness)
const serverId = "live-server"
function envelope(ids: string[]): SidebarThreadEnvelope {
  return forumSidebarEnvelopeFixture(serverId, ids, "u_me")
}

async function frame(events: CommunityWsEvent[], id: string) {
  const prepared = await prepareCommunityDeliveryEvents(events)
  if (!prepared.ok) throw new Error("invalid live window fixture")
  const encoded = await encodeCommunityBrowserEventBatchForContract({ operationId: await deriveCommunityDeliveryOperationId(id), prepared: prepared.prepared, contract: BUSINESS_SCHEMA_VERSION })
  if (!encoded.ok) throw new Error("invalid live window wire")
  expect(encoded.batch.type).toBe(communityBrowserEventBatchType())
  return encoded.batch
}

it.each(["forum", "text"] as const)("retains a promoted %s participant when an older bounded response settles after live activity", async (parentType) => {
  await mountHook({ viewerUserId: "u_me" })
  const visible = ["post_7", "post_6", "post_5", "post_4", "post_3"]
  await seedCanonicalForumSidebar(serverId, [...visible, "post_old"])
  act(() => { patchCanonicalCommunityChannel(capturedQueryClient, "post_old", row => ({ ...row, lastMessageAt: new Date(Date.now() - 60_000).toISOString() })) })
  const api = getCommunityApiFetchMock()
  const original = api.getMockImplementation()!
  let reads = 0
  let release!: (value: SidebarThreadEnvelope) => void
  const stale = envelope(visible)
  stale.resources.channels[0]!.type = parentType
  act(() => { patchCanonicalCommunityChannel(capturedQueryClient, "forum_1", row => ({ ...row, type: parentType })) })
  api.mockImplementation((...args: unknown[]) => {
    if (String(args[0]).startsWith(`/api/community/servers/${serverId}/channels?`)) {
      reads++
      return reads === 1 ? Promise.resolve(stale) : new Promise<SidebarThreadEnvelope>(resolve => { release = resolve })
    }
    return original(...args)
  })
  const sidebar = await mountCanonicalHook(() => useForumSidebarThreads(serverId, null))
  await expect.poll(() => sidebar.result.current.sidebar.status).toBe("ready")
  expect(hasCanonicalChannelNotify("post_old", "u_me")).toBe(true)
  expect(sidebar.result.current.threads.some(row => row.id === "post_old")).toBe(false)
  let refetch!: Promise<unknown>
  act(() => { refetch = capturedQueryClient.invalidateQueries({ queryKey: communityKeys.forumSidebarThreads(serverId), exact: true }) })
  await expect.poll(() => reads).toBe(2)
  const now = new Date(Date.now() + 1000).toISOString()
  const event: CommunityWsEvent = { profiles: [{ id: "u_me", name: "Me", discriminator: "0042", avatar: null, avatarVersion: 0 }], type: "community:message.create", serverId, channelId: "post_old", parentChannelId: "forum_1",
    message: messageResourceFixture({ id: "promoting-reply", channelId: "post_old", type: "chat", authorId: "u_me", authorName: "Me", authorAvatarVersion: 0, content: "Live activity lifts the oldest thread", seq: 2, createdAt: now }) }
  await act(async () => { await capturedOnMessage!(await frame([event], "promotion-race")) })
  await expect.poll(() => sidebar.result.current.threads[0]?.id).toBe("post_old")
  await act(async () => { release(stale); await refetch })
  expect(hasCanonicalChannelNotify("post_old", "u_me")).toBe(true)
  expect(sidebar.result.current.threads[0]?.id).toBe("post_old")
  const removal: CommunityWsEvent = { type: "community:channel.membership.change", relation: "notify", present: false,
    serverId, channelId: "post_old", userId: "u_me" }
  await act(async () => { await capturedOnMessage!(await frame([removal], `remove-${parentType}`)) })
  expect(hasCanonicalChannelNotify("post_old", "u_me")).toBe(false)
  await expect.poll(() => sidebar.result.current.threads.some(row => row.id === "post_old")).toBe(false)
})
