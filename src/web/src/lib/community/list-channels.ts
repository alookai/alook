import {
  queries,
  formatCanonicalRef,
  type StoredChannelType,
} from "@alook/shared"
import type {
  CommunityCliChannelGroup as ChannelGroup,
  ChannelListItem,
} from "@alook/shared"
import type { getDb } from "@/lib/db"

/**
 * Shared per-server channel-list builder for the bot arm of `GET
 * servers/[id]/channels` (single server) and `GET servers/channels` (all of a
 * bot's servers). Extracted from the pre-fold flat `listChannels` verb so the
 * two dual-actor doors emit an identical `ChannelGroup[]` shape — the folded
 * verb had this logic inline; centralizing it keeps the single/all-servers arms
 * from drifting.
 *
 * Top-level channels only (`listChannelsForMember` filters `parentChannelId IS
 * NULL`) — same visibility a human sees. Channels bucket by `categoryId`
 * (uncategorized first, then categories by position); empty category groups are
 * dropped so a private-category name never leaks. The ref is emitted through the
 * single canonical emitter (`formatCanonicalRef`), the same one send/read/ack
 * resolve against, so the list can't drift from how a ref addresses.
 */
export async function buildServerChannelGroups(
  db: ReturnType<typeof getDb>,
  server: { id: string; name: string },
  memberUserId: string,
): Promise<ChannelGroup[]> {
  const [rows, categories] = await Promise.all([
    queries.communityChannel.listChannelsForMember(db, server.id, memberUserId),
    queries.communityCategory.listCategoriesByServer(db, server.id),
  ])

  const categoryById = new Map<string, { id: string; name: string; position: number | null; private: number | null }>()
  for (const c of categories) categoryById.set(c.id, c)

  const uncategorized: ChannelListItem[] = []
  const byCategory = new Map<string, ChannelListItem[]>()

  // rows come from `listChannelsForMember` already ordered by
  // `communityChannel.position asc`; bucket into groups preserving that
  // per-bucket order.
  for (const c of rows) {
    const cat = c.categoryId ? categoryById.get(c.categoryId) : null
    const isPrivate = !!(cat && (cat.private ?? 0) === 1)
    const ref = formatCanonicalRef({
      type: (c.type ?? "text") as StoredChannelType,
      serverName: server.name,
      name: c.name,
    })
    const item: ChannelListItem = {
      ref: ref!,
      name: c.name,
      type: c.type,
      visibility: isPrivate ? "private" : "public",
    }
    if (!c.categoryId || !cat) {
      uncategorized.push(item)
    } else {
      const bucket = byCategory.get(c.categoryId) ?? []
      bucket.push(item)
      byCategory.set(c.categoryId, bucket)
    }
  }

  const serverGroups: ChannelGroup[] = []
  if (uncategorized.length > 0) {
    serverGroups.push({ category: null, channels: uncategorized })
  }
  for (const cat of categories) {
    const items = byCategory.get(cat.id)
    if (!items || items.length === 0) continue
    serverGroups.push({
      category: { name: cat.name, private: (cat.private ?? 0) === 1 },
      channels: items,
    })
  }
  return serverGroups
}
