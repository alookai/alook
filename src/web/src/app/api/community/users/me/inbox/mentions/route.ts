import { withAuth } from "@/lib/middleware/auth"
import { writeJSON } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import {
  queries,
  DEFAULT_INBOX_PAGE_SIZE,
  MAX_INBOX_PAGE_SIZE,
  readOrStale,
} from "@alook/shared"
import { parseBoundedInt } from "@/lib/community/messages"
import { avatarInitial } from "@/lib/community/avatar"
import { canonicalUserImage } from "@/lib/community/storage"

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
  type MentionRow = Awaited<ReturnType<typeof queries.communityMention.listUnreadMentions>>[number]
  type ChannelRow = Awaited<ReturnType<typeof queries.communityChannel.getChannelsByIds>>[number]
  type ServerRow = Awaited<ReturnType<typeof queries.communityServer.getServersByIds>>[number]
  const { value: fetched, stale } = await readOrStale<{
    rows: MentionRow[]
    channels: ChannelRow[]
    servers: ServerRow[]
  }>(
    async () => {
      const visibleChannelIds = await queries.communityChannel.listVisibleChannelIdsForUser(db, ctx.userId)
      const rows = await queries.communityMention.listUnreadMentions(db, ctx.userId, {
        limit: limit + 1,
        visibleChannelIds,
      })
      const channelIds = [...new Set(rows.filter((r) => r.message.channelId).map((r) => r.message.channelId!))]
      const channels = channelIds.length > 0 ? await queries.communityChannel.getChannelsByIds(db, channelIds) : []
      const serverIds = [...new Set(channels.map((ch) => ch.serverId))]
      const servers = serverIds.length > 0 ? await queries.communityServer.getServersByIds(db, serverIds) : []
      return { rows, channels, servers }
    },
    { rows: [], channels: [], servers: [] },
    { route: "community/inbox/mentions" },
  )
  if (stale) {
    return writeJSON({ mentions: [], limit, stale: true })
  }
  const { rows: fetchedRows, channels, servers } = fetched
  const truncated = fetchedRows.length > limit
  const rows = fetchedRows.slice(0, limit)
  const channelMap = new Map(channels.map((ch) => [ch.id, ch]))
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
        seq: row.message.seq,
        // authorId is the beam-avatar seed the popover renders from
        // (<Avatar seed={authorId}>); omitting it left image-less authors with
        // a blank avatar — same fix as the pins route.
        authorId: row.author.id,
        authorName: row.author.name,
        authorAvatar: canonicalUserImage(
          row.author.id,
          row.author.image,
          row.author.avatarVersion,
        ) ?? avatarInitial(row.author.name),
        authorAvatarVersion: row.author.avatarVersion,
        content: row.message.content,
        createdAt: row.message.createdAt,
      },
    }
  })

  return writeJSON({ mentions, limit, truncated })
})
