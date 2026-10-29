import { queries, withD1Retry } from "@alook/shared"
import { writeJSON } from "@/lib/middleware/helpers"
import { getPrimaryDb } from "@/lib/db"
import { withCommunityActor, rejectBot } from "@/lib/middleware/community-actor"
import { serverIconUrl } from "@/lib/community/storage"
import { createServerForUser } from "@/lib/community/create-server.server"

export const GET = withCommunityActor(async (_req, ctx) => {
  const db = getPrimaryDb(ctx.env.DB)
  const rows = await withD1Retry(
    () => queries.communityServer.listUserServers(db, ctx.actor.userId),
    { route: "community/servers:list" },
  )
  const servers = rows.map((row) => ({ ...row, icon: serverIconUrl(row) }))
  if (ctx.actor.kind === "bot") return writeJSON({ servers })

  const [visibleChannelIds, mentionSourceRows] = await Promise.all([
    withD1Retry(
      () => queries.communityChannel.listVisibleChannelIdsForUser(db, ctx.actor.userId),
      { route: "community/servers:visible-channels" },
    ),
    withD1Retry(
      () => queries.communityServer.listUnreadMentionSources(db, ctx.actor.userId),
      { route: "community/servers:mention-sources" },
    ),
  ])
  const unreadRows = await withD1Retry(
    () => queries.communityInbox.listEligibleUnreadChannels(
      db,
      ctx.actor.userId,
      visibleChannelIds,
    ),
    { route: "community/servers:unread" },
  )
  const unreadSourcesByServer = new Map<string, Array<{ channelId: string; lastUnreadSeq: number }>>()
  for (const row of unreadRows) {
    const sources = unreadSourcesByServer.get(row.serverId) ?? []
    sources.push({ channelId: row.channelId, lastUnreadSeq: row.lastUnreadSeq })
    unreadSourcesByServer.set(row.serverId, sources)
  }
  const mentionSourcesByServer = new Map<string, Array<{ channelId: string; count: number; lastSeq: number }>>()
  for (const row of mentionSourceRows) {
    if (!row.serverId) continue
    const sources = mentionSourcesByServer.get(row.serverId) ?? []
    sources.push({ channelId: row.channelId, count: row.count, lastSeq: row.lastSeq })
    mentionSourcesByServer.set(row.serverId, sources)
  }
  return writeJSON({
    servers: servers.map((server) => ({
      ...server,
      unread: unreadSourcesByServer.has(server.id),
      unreadSources: unreadSourcesByServer.get(server.id) ?? [],
      mentionSources: mentionSourcesByServer.get(server.id) ?? [],
    })),
  })
})

export const POST = withCommunityActor(async (req, ctx) => {
  const denied = rejectBot(ctx.actor)
  if (denied) return denied
  return createServerForUser(req, { env: ctx.env, userId: ctx.actor.userId })
})
