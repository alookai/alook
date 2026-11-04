import { expect, it } from "vitest"
import { BUSINESS_SCHEMA_VERSION } from "../src/business-schema-version"
import { CommunityForumSidebarEnvelopeSchema } from "../src/community-forum-sidebar"
import { CommunityResourceBundleSchema } from "../src/community-resources"
import { communityResourceChannelFixture, communityResourceMessageFixture } from "./community-ws-events.fixtures"

const parent = { ...communityResourceChannelFixture, id: "forum", type: "forum" as const }
function fixture(canonicalCount = 1, retained = false) {
  const channels = Array.from({ length: canonicalCount + Number(retained) }, (_, index) => ({
    ...communityResourceChannelFixture,
    id: index === 0 ? "post" : `post-${index}`,
    type: "thread" as const,
    parentChannelId: parent.id,
    parentMessageId: index === 0 ? "opener" : `opener-${index}`,
  }))
  const summaries = channels.map(channel => ({ id: channel.id, name: channel.name, serverId: channel.serverId!, parentChannelId: parent.id, parentMessageId: channel.parentMessageId, activityAt: "2026-10-28T00:00:00Z", expiresAt: "2026-10-31T00:00:00Z", unread: false }))
  const resources = {
    viewerId: "viewer",
    servers: [{ id: "server-1", position: 0, name: "Server", discriminator: "0042", description: "", ownerId: "viewer", icon: null, official: false, isOwner: true }],
    serverMemberships: [{ serverId: "server-1", userId: "viewer", memberId: "viewer-member", role: "owner" }],
    channels: [structuredClone(parent), ...channels],
    profiles: structuredClone(communityResourceMessageFixture.profiles),
    messages: channels.map((channel, index) => ({ ...structuredClone(communityResourceMessageFixture.message), id: channel.parentMessageId, channelId: parent.id, seq: index + 1 })),
    memberships: [
      ...[parent, ...channels].map(row => ({ channelId: row.id, userId: "viewer", relation: "access" as const, source: "explicit" as const })),
      ...channels.map(row => ({ channelId: row.id, userId: "viewer", relation: "notify" as const, source: "spoke" as const })),
    ],
  }
  CommunityResourceBundleSchema.parse(structuredClone(resources))
  return { schemaVersion: BUSINESS_SCHEMA_VERSION, serverId: "server-1", channels: summaries, canonicalChannels: summaries.slice(0, canonicalCount), retainedChannel: retained ? summaries[canonicalCount]! : null, retainedDisposition: (retained ? "eligible" : null) as "eligible" | "genuine-negative" | null, serverNow: "2026-10-28T00:00:00Z", resources }
}
it.each([false, true])("keeps canonical and retained sidebar closure: retained=%s", retained => {
  const value = fixture(retained ? 0 : 1, retained)
  const expected = structuredClone(value)
  expect(CommunityForumSidebarEnvelopeSchema.parse(value)).toEqual(expected)
  const boundary = fixture(5, retained)
  const expectedBoundary = structuredClone(boundary)
  expect(CommunityForumSidebarEnvelopeSchema.parse(boundary)).toEqual(expectedBoundary)
})
it.each(["foreign-server", "foreign-channel", "duplicate-visible", "duplicate-canonical", "parent-budget", "unselected", "retained-disposition", "wrong-type", "wrong-parent", "wrong-opener", "missing-opener", "foreign-opener", "missing-notify", "wrong-viewer", "access-is-not-notify"])("rejects broken sidebar closure: %s", defect => {
  const value = fixture(defect === "parent-budget" ? 6 : 1)
  if (defect === "foreign-server") { value.resources.servers.push({ id: "foreign", position: 0, name: "Foreign", discriminator: "0042", description: "", ownerId: "viewer", icon: null, official: false, isOwner: false }); value.resources.serverMemberships.push({ serverId: "foreign", userId: "viewer", memberId: "foreign-member", role: "member" }) }
  if (defect === "foreign-channel") value.resources.channels[0]!.serverId = null
  if (defect === "duplicate-visible") value.channels.push(value.channels[0]!)
  if (defect === "duplicate-canonical") value.canonicalChannels.push(value.canonicalChannels[0]!)
  if (defect === "unselected") value.channels[0] = { ...value.channels[0]!, id: "unselected" }
  if (defect === "retained-disposition") value.retainedDisposition = "eligible"
  if (defect === "wrong-type") value.resources.channels[1]!.type = "text"
  if (defect === "wrong-parent") value.resources.channels[1]!.parentChannelId = "foreign"
  if (defect === "wrong-opener") value.resources.channels[1]!.parentMessageId = "foreign"
  if (defect === "missing-opener") value.resources.messages = []
  if (defect === "foreign-opener") value.resources.messages[0]!.channelId = "foreign"
  if (defect === "missing-notify") value.resources.memberships = value.resources.memberships.filter(row => row.relation !== "notify")
  if (defect === "wrong-viewer") value.resources.memberships[0]!.userId = "foreign"
  if (defect === "access-is-not-notify") value.resources.memberships = value.resources.memberships.filter(row => row.relation !== "notify")
  if (defect === "wrong-parent" || defect === "foreign-opener") {
    value.resources.channels.push({ ...parent, id: "foreign" })
    value.resources.memberships.push({ channelId: "foreign", userId: "viewer", relation: "access", source: "explicit" })
  }
  expect(CommunityForumSidebarEnvelopeSchema.safeParse(value)).toMatchObject({ success: false, error: { issues: expect.arrayContaining([expect.objectContaining({ message: defect === "wrong-viewer" ? "Resource bundle scope mismatch" : "Forum sidebar resource closure mismatch" })]) } })
})
