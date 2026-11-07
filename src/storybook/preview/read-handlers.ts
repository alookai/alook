import { http } from "msw"
import { communityJson, communityError } from "./community-response"
import { BUSINESS_SCHEMA_VERSION, COMMUNITY_RESOURCE_CONTRACT_VERSION, CommunityPresenceReadSchema } from "@alook/shared"
import { parseChannelRefDestination } from "@/lib/community/channel-ref"
import { fixtureViewer, fixtureServerId, fixtureServer, fixtureCategory, fixtureChannels, fixtureProfiles, fixtureMessages, fixtureThreadMessage, fixtureDmMessages, fixtureChannel, fixtureRows, fixtureMembers, fixtureTime, emptyResources, fixtureRead, fixtureForum, fixtureInvites, fixtureDirectory, fixtureTopChannels, fixtureDms, fixtureSidebar, fixturePins } from "./read-fixtures"

const missing = () => communityError("not_found", "Local fixture not found", 404)
export const readHandlers = [
  http.get("*/api/community/users/me/server-folders", () => communityJson({ folders: [] })),
  http.get("*/api/community/users/me/channel-directory", () => communityJson(fixtureDirectory())),
  http.get("*/api/community/channel-ref", ({ request }) => {
    const destination = parseChannelRefDestination(new URL(request.url).searchParams.get("ref") ?? "")
    const channel = fixtureChannels.find((channel) => channel.serverId === fixtureServerId && (channel.id === destination?.channel || channel.name === destination?.channel))
    if (!destination || destination.server !== `${fixtureServer.name.toLowerCase()}#${fixtureServer.discriminator}` || !channel) return missing()
    return communityJson({ target: { server: { id: fixtureServerId, name: fixtureServer.name }, channel: { id: channel.id, name: channel.name, parentChannelId: channel.parentChannelId } } })
  }),
  http.get("*/api/community/servers", () => communityJson({ servers: [{ ...fixtureServer, role: "owner", memberId: "storybook-owner", mentions: 0, unread: false }] })),
  http.get(`*/api/community/servers/${fixtureServerId}/categories`, () => communityJson({ categories: [fixtureCategory] })),
  http.get(`*/api/community/servers/${fixtureServerId}/channels`, ({ request }) => {
    const url = new URL(request.url)
    return url.searchParams.get("type") === "thread" ? communityJson(fixtureSidebar(url.searchParams.get("retainId"))) : communityJson({ channels: fixtureTopChannels() })
  }),
  http.get(`*/api/community/servers/${fixtureServerId}/channels/admin`, () => communityJson({ channels: fixtureChannels.filter((channel) => channel.type === "text" || channel.type === "forum").map((channel) => ({ id: channel.id, name: channel.name, type: channel.type, category: { id: fixtureCategory.id, name: fixtureCategory.name, private: false }, creator: { name: "Gus", handle: "Gus#0000" }, createdAt: channel.createdAt })) })),
  ...["", "/search"].map((suffix) => http.get(`*/api/community/servers/${fixtureServerId}/members${suffix}`, ({ request }) => {
    const query = new URL(request.url).searchParams.get("q")?.toLowerCase() ?? ""
    const members = fixtureProfiles.filter((profile) => !query || profile.name.toLowerCase().includes(query)).slice(0, 10).map((profile) => ({ id: `storybook-member-${profile.id}`, userId: profile.id, name: profile.name, discriminator: profile.discriminator, avatar: profile.avatar, avatarVersion: profile.avatarVersion, statusEmoji: null, statusText: null, role: profile.id === fixtureViewer ? "owner" : "member", status: "online", sub: profile.aboutMe ?? "", ...(profile.kind === "bot" ? { isBot: true, ownerUserId: fixtureViewer } : {}) }))
    return communityJson({ viewerId: fixtureViewer, serverId: fixtureServerId, members, hasMore: false, limit: 100, ...(suffix ? {} : { total: members.length }) })
  })),
  http.get(`*/api/community/servers/${fixtureServerId}/invites`, () => communityJson(fixtureInvites())),
  http.get(`*/api/community/servers/${fixtureServerId}/presence`, () => communityJson(CommunityPresenceReadSchema.parse({ online: [fixtureViewer, "demo-alli", "demo-shelly"], offline: [] }))),
  http.get("*/api/community/friends/presence", () => communityJson(CommunityPresenceReadSchema.parse({ online: [], offline: [] }))),
  http.get("*/api/community/machines", ({ request }) => communityJson(new URL(request.url).searchParams.get("view") === "observations" ? { quotas: [] } : { machines: [], complete: true })),
  http.get("*/api/community/bots", () => communityJson({ bots: [], isFounder: false, plan: { id: "free", displayName: "Free" }, limit: 2, ownedCount: 0, activeCount: 0 })),
  http.get("*/api/community/automation/access-codes", () => communityJson({ accessCodes: [] })),
  http.get("*/api/community/users/me/notifications", () => communityJson([])),
  http.get("*/api/community/users/me/read-state", () => communityJson({ revision: 0, readStates: fixtureChannels.map((channel) => ({ channelId: channel.id, lastReadMessageId: fixtureRows(channel.id).at(-1)?.id ?? null, lastReadAt: fixtureTime, lastReadSeq: fixtureRows(channel.id).at(-1)?.seq ?? 0 })) })),
  http.get("*/api/community/users/me/attention", () => communityJson({ scopes: [], items: [], limit: 100, truncated: false, included: { servers: [], channels: [], dms: [], profiles: [], messages: [] }, resources: emptyResources() })),
  http.get("*/api/community/users/me/dms", () => communityJson(fixtureDms())),
  ...["accepted", "blocked", "pending"].map((bucket) => http.get(`*/api/community/friends/${bucket}`, () => communityJson({ contractVersion: BUSINESS_SCHEMA_VERSION, [bucket === "accepted" ? "friends" : bucket]: [], resources: emptyResources() }))),
  http.get("*/api/community/channels/:channelId/pins", ({ params }) => {
    const result = fixturePins(String(params.channelId))
    return result ? communityJson(result) : undefined
  }),
  http.get("*/api/community/channels/:channelId/messages/seq/:seq", ({ params }) => {
    if (!fixtureChannel(String(params.channelId))) return
    const row = fixtureRows(String(params.channelId)).find((row) => row.seq === Number(params.seq))
    return row ? communityJson({ id: row.id }) : missing()
  }),
  http.get("*/api/community/channels/:channelId/messages", ({ params, request }) => {
    if (!fixtureChannel(String(params.channelId))) return
    const result = fixtureRead(String(params.channelId), request.url)
    return result ? communityJson(result) : missing()
  }),
  http.get("*/api/community/messages/:messageId", ({ params }) => {
    const message = [...fixtureMessages, fixtureThreadMessage, ...fixtureDmMessages].find((row) => row.id === params.messageId)
    if (!message) return
    return communityJson({ contractVersion: COMMUNITY_RESOURCE_CONTRACT_VERSION, channelId: message.channelId, message, profiles: fixtureProfiles })
  }),
  http.get("*/api/community/channels/:channelId/threads", ({ params }) => fixtureChannel(String(params.channelId)) ? communityJson(fixtureForum(String(params.channelId))) : undefined),
  http.get("*/api/community/channels/:channelId/members", ({ params, request }) => {
    if (!fixtureChannel(String(params.channelId))) return
    const relation = new URL(request.url).searchParams.get("relation") === "notify" ? "notify" : "access"
    return communityJson({ contractVersion: COMMUNITY_RESOURCE_CONTRACT_VERSION, channelId: params.channelId, relation, members: fixtureMembers(String(params.channelId)).map((member) => ({ ...member, relation })), profiles: fixtureProfiles })
  }),
]
