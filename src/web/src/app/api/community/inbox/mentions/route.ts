import { withAuth } from "@/lib/middleware/auth"
import { writeJSON } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import {
  queries,
  DEFAULT_INBOX_PAGE_SIZE,
  MAX_INBOX_PAGE_SIZE,
} from "@alook/shared"
import { parseBoundedInt } from "@/lib/community/messages"
import { avatarInitial } from "@/lib/community/avatar"

export const GET = withAuth(async (req, ctx) => {
  const db = getDb(ctx.env.DB)
  const url = new URL(req.url)
  const limit = parseBoundedInt(
    url.searchParams.get("limit"),
    DEFAULT_INBOX_PAGE_SIZE,
    MAX_INBOX_PAGE_SIZE,
  )

  // Both `@`-mentions AND reply notifications surface in the Mentions tab now.
  // Scope to the viewer's visible channels (scope-first, in-query) so a
  // removed-from-private-channel user no longer sees leftover mentions; the
  // `inArray(channelId, visibleIds)` also naturally excludes DM reply rows
  // (channelId = NULL), which stay out of the Mentions tab by design.
  const visibleChannelIds = await queries.communityChannel.listVisibleChannelIdsForUser(db, ctx.userId)
  const rows = await queries.communityMention.listUnreadMentions(db, ctx.userId, {
    limit,
    visibleChannelIds,
  })

  const channelIds = [...new Set(rows.filter((r) => r.message.channelId).map((r) => r.message.channelId!))]
  const channels = channelIds.length > 0 ? await queries.communityChannel.getChannelsByIds(db, channelIds) : []
  const channelMap = new Map(channels.map((ch) => [ch.id, ch]))

  const serverIds = [...new Set(channels.map((ch) => ch.serverId))]
  const servers = serverIds.length > 0 ? await queries.communityServer.getServersByIds(db, serverIds) : []
  const serverMap = new Map(servers.map((s) => [s.id, s]))

  const mentions = rows.map((row) => {
    const ch = row.message.channelId ? channelMap.get(row.message.channelId) : undefined
    const srv = ch ? serverMap.get(ch.serverId) : undefined
    return {
      id: row.mention.id,
      // "mention" (@-mention) vs "reply" — the UI labels them differently
      // ("mentioned you" vs "replied to you").
      kind: row.mention.kind,
      // srv/ch fall back to "Unknown" only when the underlying row was deleted
      // between mention insert and this read — unrelated to user-name integrity.
      server: srv ? srv.name : "Unknown",
      serverId: ch?.serverId,
      channel: ch ? ch.name : "Unknown",
      channelId: row.message.channelId,
      m: {
        id: row.message.id,
        authorName: row.author.name,
        authorAvatar: row.author.image ?? avatarInitial(row.author.name),
        content: row.message.content,
        createdAt: row.message.createdAt,
      },
    }
  })

  return writeJSON({ mentions, limit })
})
