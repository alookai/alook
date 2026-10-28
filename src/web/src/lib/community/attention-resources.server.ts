import {
  AccountAttentionSnapshotSchema, communityMessageProfileIds, COMMUNITY_RESOURCE_CONTRACT_VERSION,
  CommunityChannelMembershipResourceSchema, CommunityResourceBundleSchema, CommunityServerResourceSchema, communityChannelResourceFromStorage, isServerOwner, queries,
  withD1Retry, type CommunityResourceBundle, type AccountAttentionProjection, type AccountAttentionSnapshot, type Database,
} from "@alook/shared"
import { loadApiMessageContext, mapMessageForApi } from "./message-payload"
import { serverIconUrl } from "./storage"
import { readCommunityResourceProfiles } from "./resource-profiles.server"

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
  const readChannels = async (ids: string[]) => {
    const rows = await withD1Retry(() => queries.communityChannel.listReadableMessageChannelsForUser(db, viewerId, ids), { route: "community/permissions:channel-member" })
    const byId = new Map(rows.map(row => [row.id, row]))
    if (ids.some(id => !byId.has(id))) throw new Error("Attention access changed")
    return ids.map(id => communityChannelResourceFromStorage(byId.get(id)!))
  }
  const channels = await readChannels([...channelIds])
  const missingParents = [...new Set(channels.flatMap(row => row.parentChannelId && !channelIds.has(row.parentChannelId) ? [row.parentChannelId] : []))]
  if (missingParents.length) channels.push(...await readChannels(missingParents))
  const allowedIds = channels.map(row => row.id)
  const [messageRows, serverRows, membershipRows] = await Promise.all([
    queries.communityMessage.getMessagesByIdsInChannels(db, input.messageIds ?? [], allowedIds),
    channels.some(row => row.serverId !== null) || input.serverIds?.length ? queries.communityServer.listUserServers(db, viewerId) : Promise.resolve([]),
    queries.communityChannel.listChannelMembershipsForUserInChannels(db, viewerId, allowedIds),
  ])
  if (input.messageIds?.some(id => !messageRows.some(row => row.id === id))) throw new Error("Requested message resource missing from scope")
  const context = await loadApiMessageContext(db, viewerId, messageRows.map(row => row.id), () =>
    queries.communityMessage.getMessagesByIdsInChannels(db, messageRows.flatMap(row => row.replyToId ? [row.replyToId] : []), allowedIds), true)
  const messages = messageRows.map(row => mapMessageForApi(row, context(row.channelId), COMMUNITY_RESOURCE_CONTRACT_VERSION, row.channelId))
  const profiles = await readCommunityResourceProfiles(db, [viewerId, ...(input.profileIds ?? []), ...communityMessageProfileIds(messages)])
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
      profiles,
      messages,
  })
}
