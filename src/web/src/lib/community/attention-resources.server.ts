import {
  AccountAttentionSnapshotSchema, COMMUNITY_RESOURCE_CONTRACT_VERSION, CommunityResourceProfileSchema,
  CommunityChannelMembershipResourceSchema, CommunityResourceBundleSchema, CommunityServerResourceSchema, communityChannelResourceFromStorage, isServerOwner, queries,
  type CommunityResourceBundle, type AccountAttentionProjection, type AccountAttentionSnapshot, type Database,
} from "@alook/shared"
import { requireMessageSurfaceAccess } from "./permissions"
import { loadApiMessageContext, mapMessageForApi } from "./message-payload"
import { canonicalUserImage, serverIconUrl } from "./storage"

export async function hydrateAttentionResources(db: Database, viewerId: string, projection: AccountAttentionProjection): Promise<AccountAttentionSnapshot> {
  const resources = await readCommunityResourceBundle(db, viewerId, {
    channelIds: [...projection.included.channels.map(row => row.id), ...projection.included.dms.map(row => row.id), ...projection.included.messages.map(row => row.channelId)],
    profileIds: projection.included.profiles.map(row => row.userId), messageIds: projection.included.messages.map(row => row.id), serverIds: projection.included.servers.map(row => row.id),
  })
  return AccountAttentionSnapshotSchema.parse({ ...projection, resources: { ...resources, memberships: resources.memberships.filter(row => row.relation === "access") } })
}

export async function readCommunityResourceBundle(db: Database, viewerId: string, input: {
  channelIds: string[]; profileIds?: string[]; messageIds?: string[]; serverIds?: string[]
}): Promise<CommunityResourceBundle> {
  const channelIds = new Set(input.channelIds)
  const readChannel = async (id: string) => {
    const access = await requireMessageSurfaceAccess(db, id, viewerId)
    if (!access.ok) throw new Error("Attention access changed")
    return communityChannelResourceFromStorage(access.value.channel)
  }
  const channels = await Promise.all([...channelIds].map(readChannel))
  const missingParents = [...new Set(channels.flatMap(row => row.parentChannelId && !channelIds.has(row.parentChannelId) ? [row.parentChannelId] : []))]
  channels.push(...await Promise.all(missingParents.map(readChannel)))
  const allowedIds = channels.map(row => row.id)
  const [messageRows, serverRows, membershipRows] = await Promise.all([
    queries.communityMessage.getMessagesByIdsInChannels(db, input.messageIds ?? [], allowedIds),
    channels.some(row => row.serverId !== null) || input.serverIds?.length ? queries.communityServer.listUserServers(db, viewerId) : Promise.resolve([]),
    queries.communityChannel.listChannelMembershipsForUserInChannels(db, viewerId, allowedIds),
  ])
  if (input.messageIds?.some(id => !messageRows.some(row => row.id === id))) throw new Error("Requested message resource missing from scope")
  const userRows = await queries.user.getUsersByIds(db, [...new Set([viewerId, ...(input.profileIds ?? []), ...messageRows.map(row => row.authorId)])])
  const context = await loadApiMessageContext(db, viewerId, messageRows.map(row => row.id), () =>
    queries.communityMessage.getMessagesByIdsInChannels(db, messageRows.flatMap(row => row.replyToId ? [row.replyToId] : []), allowedIds), true)
  const profileRows = await queries.communityUserProfile.getProfilesByUserIds(db, userRows.map(row => row.id))
  const profileByUser = new Map(profileRows.map(row => [row.userId, row]))
  const serverIds = new Set([...(input.serverIds ?? []), ...channels.flatMap(row => row.serverId ? [row.serverId] : [])])
  const selectedServers = serverRows.flatMap((row, position) => serverIds.has(row.id) ? [{ row, position }] : [])
  const relations = membershipRows.map(row => CommunityChannelMembershipResourceSchema.parse(row))
  const accessByChannel = new Map(relations.filter(row => row.relation === "access").map(row => [row.channelId, row]))
  return CommunityResourceBundleSchema.parse({
      viewerId,
      servers: selectedServers.map(({ row, position }) => CommunityServerResourceSchema.parse({
        id: row.id, position, name: row.name, discriminator: row.discriminator, description: row.description,
        ownerId: row.ownerId, icon: serverIconUrl(row), official: row.official, isOwner: isServerOwner(row.role),
      })),
      serverMemberships: selectedServers.map(({ row }) => ({ serverId: row.id, userId: viewerId, memberId: row.memberId, role: row.role })),
      channels,
      memberships: [...channels.map(row => accessByChannel.get(row.id) ?? { channelId: row.id, userId: viewerId, relation: "access", source: "access-decision" }), ...relations.filter(row => row.relation === "notify")],
      profiles: userRows.map(row => CommunityResourceProfileSchema.parse({
        id: row.id, name: row.name, discriminator: row.discriminator,
        ...(profileByUser.has(row.id) ? { aboutMe: profileByUser.get(row.id)!.aboutMe, bannerColor: profileByUser.get(row.id)!.bannerColor, statusEmoji: profileByUser.get(row.id)!.statusEmoji, statusText: profileByUser.get(row.id)!.statusText } : {}),
        avatar: canonicalUserImage(row.id, row.image, row.avatarVersion), avatarVersion: row.avatarVersion,
      })),
      messages: messageRows.map(row => mapMessageForApi(row, context(row.channelId), COMMUNITY_RESOURCE_CONTRACT_VERSION, row.channelId)),
  })
}
