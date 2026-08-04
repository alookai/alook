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

// Cross-channel Marked tab: every message the current user has marked, newest
// first. Scoped to the viewer's visible channels in-query (same guard as the
// Mentions tab) so a mark in a private channel the user has since left never
// leaks. Each row carries serverId + channelId + seq — the frontend needs all
// three to navigate: serverId/channelId locate the channel, m.seq jumps to the
// message (a marked message is usually outside the loaded window, so a
// seq-less scroll would silently no-op).
export const GET = withAuth(async (req, ctx) => {
  const db = getDb(ctx.env.DB)
  const url = new URL(req.url)
  const limit = parseBoundedInt(
    url.searchParams.get("limit"),
    DEFAULT_INBOX_PAGE_SIZE,
    MAX_INBOX_PAGE_SIZE,
  )

  type MarkRow = Awaited<ReturnType<typeof queries.communityMessageMark.listMarksForUser>>[number]
  type ChannelRow = Awaited<ReturnType<typeof queries.communityChannel.getChannelsByIds>>[number]
  type ServerRow = Awaited<ReturnType<typeof queries.communityServer.getServersByIds>>[number]
  const { value: fetched, stale } = await readOrStale<{
    rows: MarkRow[]
    channels: ChannelRow[]
    servers: ServerRow[]
  }>(
    async () => {
      // The Marked tab spans DMs as well as server channels. DM channels carry
      // server_id = NULL, so they're absent from listVisibleChannelIdsForUser
      // (which walks server memberships) — union in the user's DM channels so a
      // marked DM message isn't silently filtered out. Access-membership is the
      // DM visibility gate in both helpers, so no cross-user leak.
      const [serverChannelIds, dmChannelIds] = await Promise.all([
        queries.communityChannel.listVisibleChannelIdsForUser(db, ctx.userId),
        queries.communityDm.listDmChannelIdsForUser(db, ctx.userId),
      ])
      const visibleChannelIds = [...serverChannelIds, ...dmChannelIds]
      const rows = await queries.communityMessageMark.listMarksForUser(db, ctx.userId, {
        limit,
        visibleChannelIds,
      })
      const channelIds = [...new Set(rows.map((r) => r.mark.channelId))]
      const channels = channelIds.length > 0 ? await queries.communityChannel.getChannelsByIds(db, channelIds) : []
      const serverIds = [...new Set(channels.map((ch) => ch.serverId))]
      const servers = serverIds.length > 0 ? await queries.communityServer.getServersByIds(db, serverIds) : []
      return { rows, channels, servers }
    },
    { rows: [], channels: [], servers: [] },
    { route: "community/inbox/marked" },
  )
  if (stale) {
    return writeJSON({ marked: [], limit, stale: true })
  }
  const { rows, channels, servers } = fetched
  const channelMap = new Map(channels.map((ch) => [ch.id, ch]))
  const serverMap = new Map(servers.map((s) => [s.id, s]))

  const marked = rows.map((row) => {
    const ch = channelMap.get(row.mark.channelId)
    const srv = ch ? serverMap.get(ch.serverId) : undefined
    return {
      id: row.mark.id,
      server: srv ? srv.name : "Unknown",
      serverId: ch?.serverId,
      channel: ch ? ch.name : "Unknown",
      channelId: row.mark.channelId,
      m: {
        id: row.message.id,
        authorId: row.author.id,
        authorName: row.author.name,
        authorAvatar: row.author.image ?? avatarInitial(row.author.name),
        content: row.message.content,
        // seq is the jump key (Msg.seq) — a marked message is usually outside
        // the loaded window, so a seq-less scroll silently no-ops. Lives inside
        // `m` to match the frontend `Marked` type (m: Msg).
        seq: row.message.seq,
        createdAt: row.message.createdAt,
      },
    }
  })

  return writeJSON({ marked, limit })
})
