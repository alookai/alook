import { expect, it } from "vitest"
import { BUSINESS_SCHEMA_VERSION } from "../src/business-schema-version"
import { CommunityForumSidebarEnvelopeSchema } from "../src/community-forum-sidebar"
import { CommunityResourceBundleSchema } from "../src/community-resources"
import { communityResourceChannelFixture, communityResourceMessageFixture } from "./community-ws-events.fixtures"

const parent = { ...communityResourceChannelFixture, id: "forum", type: "forum" as const }
function fixture() {
  const channel = { ...communityResourceChannelFixture, id: "post", type: "thread" as const, parentChannelId: parent.id, parentMessageId: "opener" }
  const summary = { id: channel.id, name: channel.name, serverId: channel.serverId!, parentChannelId: parent.id, parentMessageId: "opener", activityAt: "2026-10-28T00:00:00Z", expiresAt: "2026-10-31T00:00:00Z", unread: false }
  return { schemaVersion: BUSINESS_SCHEMA_VERSION, serverId: "server-1", channels: [summary], canonicalChannels: [summary], retainedChannel: null as typeof summary | null, retainedDisposition: null as "eligible" | "genuine-negative" | null, serverNow: "2026-10-28T00:00:00Z",
    resources: CommunityResourceBundleSchema.parse({ viewerId: "viewer", servers: [{ id: "server-1", position: 0, name: "Server", discriminator: "0042", description: "", ownerId: "viewer", icon: null, official: false, isOwner: true }], serverMemberships: [{ serverId: "server-1", userId: "viewer", memberId: "viewer-member", role: "owner" }], channels: [parent, channel], profiles: communityResourceMessageFixture.profiles, messages: [{ ...communityResourceMessageFixture.message, id: "opener", channelId: "forum" }], memberships: [ ...[parent, channel].map(row => ({ channelId: row.id, userId: "viewer", relation: "access", source: "explicit" })), { channelId: "post", userId: "viewer", relation: "notify", source: "spoke" }] }) }
}
it.each([false, true])("keeps canonical and retained sidebar closure: retained=%s", retained => {
  const value = fixture()
  if (retained) { value.canonicalChannels = []; value.retainedChannel = value.channels[0]!; value.retainedDisposition = "eligible" }
  expect(CommunityForumSidebarEnvelopeSchema.parse(value)).toEqual(value)
})
it.each(["foreign-server", "foreign-channel", "duplicate-visible", "duplicate-canonical", "parent-budget", "unselected", "retained-disposition", "wrong-type", "wrong-parent", "wrong-opener", "missing-opener", "foreign-opener", "missing-notify", "wrong-viewer", "access-is-not-notify"])("rejects broken sidebar closure: %s", defect => {
  const value = fixture()
  if (defect === "foreign-server") { value.resources.servers.push({ id: "foreign", position: 0, name: "Foreign", discriminator: "0042", description: "", ownerId: "viewer", icon: null, official: false, isOwner: false }); value.resources.serverMemberships.push({ serverId: "foreign", userId: "viewer", memberId: "foreign-member", role: "member" }) }
  if (defect === "foreign-channel") value.resources.channels[0]!.serverId = null
  if (defect === "duplicate-visible") value.channels.push(value.channels[0]!)
  if (defect === "duplicate-canonical") value.canonicalChannels.push(value.canonicalChannels[0]!)
  if (defect === "parent-budget") value.canonicalChannels = Array.from({ length: 6 }, (_, i) => ({ ...value.canonicalChannels[0]!, id: `post-${i}` }))
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
