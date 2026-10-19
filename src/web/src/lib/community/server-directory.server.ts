import { queries, UNCATEGORIZED_CATEGORY_ID, type Database } from "@alook/shared"
import type { ServerDetail } from "@/hooks/community/use-servers"
import { requireServerMember } from "./permissions"
import { serverIconUrl } from "./storage"

export function readCommunityServerCategoryRows(db: Database, serverId: string) {
  return db.query.communityCategory.findMany({ where: (t, { eq }) => eq(t.serverId, serverId), orderBy: (t, { asc }) => [asc(t.position)] })
}

export function readCommunityServerChannelRows(db: Database, serverId: string, viewerId: string) {
  return queries.communityChannel.listServerChannelsForViewer(db, serverId, viewerId)
}

export async function readCommunityServerDirectory(db: Database, viewerId: string, serverId: string): Promise<ServerDetail | undefined> {
  const access = await requireServerMember(db, serverId, viewerId)
  if (!access.ok) return
  const [server, categoryRows, channelRows] = await Promise.all([
    queries.communityServer.getServer(db, serverId),
    readCommunityServerCategoryRows(db, serverId),
    readCommunityServerChannelRows(db, serverId, viewerId),
  ])
  if (!server) return
  const channels = channelRows.map(channel => ({ ...channel, active: false, unread: false }))
  const categories: ServerDetail["categories"] = categoryRows.map(category => ({ ...category, private: !!category.private, channels: channels.filter(channel => channel.categoryId === category.id) }))
  const uncategorized = channels.filter(channel => !channel.categoryId)
  if (uncategorized.length) categories.push({ id: UNCATEGORIZED_CATEGORY_ID, name: "", private: 0, channels: uncategorized })
  return { id: server.id, name: server.name, discriminator: server.discriminator, description: server.description ?? "", icon: serverIconUrl(server), official: server.official === true, ownerId: server.ownerId, categories }
}
