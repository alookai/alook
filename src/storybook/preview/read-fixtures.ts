import {
  BUSINESS_SCHEMA_VERSION, COMMUNITY_RESOURCE_CONTRACT_VERSION,
  CommunityResourceProfileSchema, CommunityChannelResourceSchema, CommunityMessageResourceSchema,
  CommunityResourceBundleSchema, CommunityConversationEntryReadSchema, CommunityMessagesReadSchema,
  CommunityThreadsReadSchema, CommunityInvitesReadSchema, CommunityDmsReadSchema, CommunityForumSidebarEnvelopeSchema,
} from "@alook/shared"
import { DEMO_MESSAGES, DEMO_PROFILES } from "@/components/home/landing-interactive-shell-data"
import type { PinsResponse } from "@/hooks/community/use-channel-panels"
import type { ChannelRefDirectory } from "@/lib/community/channel-ref"

export const fixtureViewer = "demo-gus"
export const fixtureServerId = "demo-studio"
export const fixtureTime = "2026-11-01T12:00:00Z"
export const fixtureProfiles = [...DEMO_PROFILES.values()].map((profile) => CommunityResourceProfileSchema.parse({ id: profile.id, name: profile.name ?? profile.id, discriminator: profile.discriminator || "0000", avatar: profile.avatar ?? null, avatarVersion: 0, aboutMe: profile.aboutMe ?? "", kind: profile.kind ?? "human", ownerUserId: profile.kind === "bot" ? profile.ownerUserId ?? fixtureViewer : null }))
export const fixtureServer = { id: fixtureServerId, position: 0, name: "Studio", discriminator: "4012", description: "Local component preview", ownerId: fixtureViewer, icon: null, official: false, isOwner: true }
export const fixtureCategory = { id: "storybook-category", serverId: fixtureServerId, name: "Preview", position: 0, private: false, creatorId: fixtureViewer }
const channelBase = { serverId: fixtureServerId, categoryId: fixtureCategory.id, topic: "", parentChannelId: null, parentMessageId: null, creatorId: fixtureViewer, position: 0, archived: false, createdAt: fixtureTime, lastMessageAt: fixtureTime, messageCount: 4 }
const sourceMessages = DEMO_MESSAGES["demo-general"].slice(0, 4)
export const fixtureChannels = [
  CommunityChannelResourceSchema.parse({ ...channelBase, id: "demo-general", type: "text", name: "general" }),
  CommunityChannelResourceSchema.parse({ ...channelBase, id: "storybook-forum", type: "forum", name: "Ideas", messageCount: 0 }),
  CommunityChannelResourceSchema.parse({ ...channelBase, id: "storybook-thread", type: "thread", name: "Project review", parentChannelId: "demo-general", parentMessageId: sourceMessages[0]!.id, messageCount: 1 }),
  CommunityChannelResourceSchema.parse({ ...channelBase, id: "storybook-dm", type: "dm", name: null, serverId: null, categoryId: null }),
]
export const fixtureMessages = sourceMessages.map((message, index) => CommunityMessageResourceSchema.parse({ id: message.id, channelId: "demo-general", seq: index + 1, authorId: message.authorId ?? fixtureViewer, createdAt: message.createdAt ?? fixtureTime, type: message.type, content: message.content ?? "", replyToId: null, clientNonce: null, attachments: [] }))
export const fixtureThreadMessage = CommunityMessageResourceSchema.parse({ ...fixtureMessages[1]!, id: "storybook-thread-reply", channelId: "storybook-thread", seq: 1 })
export const fixtureDmMessages = fixtureMessages.map((message, index) => CommunityMessageResourceSchema.parse({ ...message, authorId: index % 2 ? "demo-alli" : fixtureViewer, id: `storybook-dm-${message.seq}`, channelId: "storybook-dm" }))
export const fixtureChannel = (id: string) => fixtureChannels.find((channel) => channel.id === id)
export const fixtureRows = (id: string) => id === "demo-general" ? fixtureMessages : id === "storybook-thread" ? [fixtureThreadMessage] : id === "storybook-dm" ? fixtureDmMessages : []
export const fixtureMembers = (id: string) => (id === "storybook-dm" ? [fixtureViewer, "demo-alli"] : [fixtureViewer, "demo-alli", "demo-shelly"]).map((userId) => ({ channelId: id, userId, relation: "access" as const, source: "explicit" as const, isCreator: userId === fixtureViewer, role: userId === fixtureViewer ? "owner" : "member", memberId: `storybook-member-${userId}` }))
export const emptyResources = () => ({ viewerId: fixtureViewer, servers: [], serverMemberships: [], channels: [], memberships: [], messages: [], profiles: [] })
export function fixtureResources() {
  return CommunityResourceBundleSchema.parse({ viewerId: fixtureViewer, servers: [fixtureServer], serverMemberships: [{ serverId: fixtureServerId, userId: fixtureViewer, memberId: "storybook-owner", role: "owner" }], channels: fixtureChannels, memberships: fixtureChannels.map((channel) => ({ channelId: channel.id, userId: fixtureViewer, relation: "access", source: "explicit" })), messages: [...fixtureMessages, fixtureThreadMessage, ...fixtureDmMessages], profiles: fixtureProfiles })
}
export const fixtureTopChannels = () => fixtureChannels.filter((channel) => channel.serverId === fixtureServerId && channel.parentChannelId === null)
export function fixtureDms() {
  return CommunityDmsReadSchema.parse({ conversations: [{ id: "storybook-dm", userId: "demo-alli", channel: fixtureChannel("storybook-dm"), profile: fixtureProfiles.find((profile) => profile.id === "demo-alli"), memberships: fixtureMembers("storybook-dm"), preview: "A local direct message", activityAt: fixtureTime, unread: false }] })
}
export function fixtureDirectory() {
  const channels = fixtureTopChannels()
  const directory: ChannelRefDirectory = [{ id: fixtureServerId, name: fixtureServer.name, discriminator: fixtureServer.discriminator, channels: channels.flatMap((channel) => channel.type === "text" || channel.type === "forum" ? [{ id: channel.id, name: channel.name ?? channel.id, type: channel.type }] : []) }]
  const resources = fixtureResources()
  const ids = new Set(channels.map((channel) => channel.id))
  return { directory, resources: CommunityResourceBundleSchema.parse({ ...resources, channels, memberships: resources.memberships.filter((row) => ids.has(row.channelId)), messages: [] }) }
}
export function fixtureSidebar(retainId: string | null) {
  const thread = fixtureChannel("storybook-thread")!
  const summary = { id: thread.id, name: thread.name, serverId: fixtureServerId, parentChannelId: thread.parentChannelId, parentMessageId: thread.parentMessageId, activityAt: fixtureTime, expiresAt: "2026-11-04T12:00:00Z", unread: false }
  const all = fixtureResources()
  const channels = all.channels.filter((channel) => channel.serverId === fixtureServerId)
  const ids = new Set(channels.map((channel) => channel.id))
  const resources = CommunityResourceBundleSchema.parse({ ...all, channels, memberships: [...all.memberships.filter((row) => ids.has(row.channelId)), { channelId: thread.id, userId: fixtureViewer, relation: "notify", source: "explicit" }], messages: [fixtureMessages[0]] })
  const retained = retainId === thread.id
  return CommunityForumSidebarEnvelopeSchema.parse({ schemaVersion: BUSINESS_SCHEMA_VERSION, serverId: fixtureServerId, channels: [summary], canonicalChannels: [summary], retainedChannel: retained ? summary : null, retainedDisposition: retainId ? retained ? "eligible" : "genuine-negative" : null, resources, serverNow: fixtureTime })
}
export function fixtureForum(id: string) {
  return CommunityThreadsReadSchema.parse({ contractVersion: COMMUNITY_RESOURCE_CONTRACT_VERSION, channelId: id, channel: fixtureChannel(id), threads: [], included: { messages: [], profiles: [], members: [], tags: [], participantCounts: [] }, page: { nextCursor: null, hasMore: false } })
}
export function fixtureRead(id: string, requestUrl: string) {
  const channel = fixtureChannel(id)
  if (!channel) return null
  const url = new URL(requestUrl)
  const rows = fixtureRows(id)
  const latest = rows.at(-1)?.seq ?? 0
  const after = url.searchParams.has("newAfterSeq") ? Number(url.searchParams.get("newAfterSeq")) : latest
  if (!Number.isSafeInteger(after) || after < 0 || after > latest) return null
  const firstNew = rows.find((row) => row.seq > after && row.authorId !== fixtureViewer)
  const page = { olderCursor: null, newerCursor: null, hasMoreOlder: false, hasMoreNewer: false, latestSeq: latest }
  const window = { contractVersion: COMMUNITY_RESOURCE_CONTRACT_VERSION, channelId: id, messages: rows, profiles: fixtureProfiles, page, surfaceReceipt: { channelId: id, surfaceKind: channel.type === "text" ? "channel" : channel.type } }
  if (url.searchParams.get("entry") !== "1") return CommunityMessagesReadSchema.parse(window)
  const anchor = url.searchParams.get("anchor")
  if (anchor && !rows.some((row) => row.id === anchor)) return null
  return CommunityConversationEntryReadSchema.parse({ ...window, viewerId: fixtureViewer, peer: channel.type === "dm" ? fixtureProfiles.find((profile) => profile.id === "demo-alli") : null, channel, access: { channelId: id, canRead: true, canSend: true, canCreateDiscussion: true }, readState: { channelId: id, lastReadMessageId: rows.at(-1)?.id ?? null, lastReadAt: rows.length ? fixtureTime : null, lastReadSeq: latest }, readStateRevision: 0, newBoundary: { afterSeq: after, target: firstNew ? { id: firstNew.id, channelId: firstNew.channelId, seq: firstNew.seq, authorId: firstNew.authorId } : null }, selection: { reason: anchor ? "explicit_anchor" : "tail", anchorMessageId: anchor }, ...(channel.type === "forum" ? { forumFeed: fixtureForum(id) } : {}), ...(channel.type === "thread" ? { opener: fixtureMessages[0], parent: fixtureChannel("demo-general") } : {}) })
}
export function fixturePins(id: string): PinsResponse | null {
  const channel = fixtureChannel(id)
  if (!channel) return null
  const all = fixtureResources()
  const ids = new Set([id, ...(channel.parentChannelId ? [channel.parentChannelId] : [])])
  return { pins: [], resources: CommunityResourceBundleSchema.parse({
    viewerId: fixtureViewer,
    channels: all.channels.filter((row) => ids.has(row.id)),
    memberships: all.memberships.filter((row) => ids.has(row.channelId)),
    servers: all.servers.filter((row) => row.id === channel.serverId),
    serverMemberships: all.serverMemberships.filter((row) => row.serverId === channel.serverId),
    profiles: all.profiles.filter((row) => row.id === fixtureViewer),
    messages: [],
  }) }
}
export function fixtureInvites() {
  const resources = fixtureResources()
  return CommunityInvitesReadSchema.parse({ contractVersion: BUSINESS_SCHEMA_VERSION, serverId: fixtureServerId, invites: [{ id: "storybook-invite", token: "storybook-local-invite", maxUses: 10, uses: 0, expiresAt: null, createdAt: fixtureTime, creatorId: fixtureViewer }], resources: { ...resources, channels: [], memberships: [], messages: [] } })
}
