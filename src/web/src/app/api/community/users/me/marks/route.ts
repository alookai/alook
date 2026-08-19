import { withCommunityActor } from "@/lib/middleware/community-actor"
import { writeJSON } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import {
  queries,
  DEFAULT_INBOX_PAGE_SIZE,
  MAX_INBOX_PAGE_SIZE,
  readOrStale,
  withD1Retry,
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
export const GET = withCommunityActor(async (req, ctx) => {
  const db = getDb(ctx.env.DB)
  const userId = ctx.actor.userId

  if (ctx.actor.kind === "bot") {
    const visibleChannelIds = await withD1Retry(
      () => queries.communityAgentInbox.listAccessVisibleChannelIdsForUser(db, userId),
      { route: "community/users/me/marks:visibility" },
    )
    const rows = await withD1Retry(
      () => queries.communityMessageMark.listMarksForUser(db, userId, { visibleChannelIds }),
      { route: "community/users/me/marks:list" },
    )
    const attachmentRows = await withD1Retry(
      () => queries.communityAttachment.listByMessageIds(db, rows.map((row) => row.message.id)),
      { route: "community/users/me/marks:attachments" },
    )
    const attachmentsByMessageId = new Map<string, Array<{
      id: string
      filename: string
      contentType: string | null
      size: number | null
    }>>()
    for (const attachment of attachmentRows) {
      if (!attachment.messageId) continue
      const list = attachmentsByMessageId.get(attachment.messageId) ?? []
      list.push({
        id: attachment.id,
        filename: attachment.filename,
        contentType: attachment.contentType,
        size: attachment.size,
      })
      attachmentsByMessageId.set(attachment.messageId, list)
    }
    const marked = await withD1Retry(
      () => queries.communityAgentInbox.toAgentMessages(
        db,
        rows.map((row) => row.message),
        userId,
        attachmentsByMessageId,
      ),
      { route: "community/users/me/marks:hydrate" },
    )
    return writeJSON({ marked })
  }

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
      // marked DM message isn't silently filtered out. The shared helper also
      // excludes DMs blocked in either direction, so no stale body can leak.
      const visibleChannelIds = await queries.communityAgentInbox
        .listAccessVisibleChannelIdsForUser(db, userId)
      const rows = await queries.communityMessageMark.listMarksForUser(db, userId, {
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
    { route: "community/marks" },
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
      parentChannelId: ch?.parentChannelId ?? null,
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
