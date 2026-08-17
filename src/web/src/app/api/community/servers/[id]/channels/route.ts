import { NextResponse, NextRequest } from "next/server"
import { getDb } from "@/lib/db"
import { compareAsciiSqliteBinary, isForum, parseNameAndTag, queries } from "@alook/shared"
import { withCommunityActor } from "@/lib/middleware/community-actor"
import { buildServerChannelGroups } from "@/lib/community/list-channels"
import { requireServerMember } from "@/lib/community/permissions"

/**
 * GET /api/community/servers/[id]/channels — single-server channel list. Human
 * callers receive the visible top-level tree, with one strict participating
 * forum-thread projection used by the nested sidebar. The bot arm implements
 * the folded `listChannels` verb (route/disc trunk, 接口树统一 轴3). The
 * bot addresses by `?server=<name#discriminator>`; the all-servers mode
 * (bot omitting `server`) lives at the servers-collection route `GET
 * servers/channels` instead — a cross-server aggregate has no single-`[id]`
 * home.
 *
 * ①-C existence mask: `resolveServerByNameForMember` is member-scoped, so a
 * server the bot isn't in returns zero matches → 404 (indistinguishable from a
 * nonexistent server). `buildServerChannelGroups` runs `listChannelsForMember`
 * so private-category channels the bot can't see never appear.
 */
export const GET = withCommunityActor(async (req: NextRequest, ctx) => {
  const db = getDb(ctx.env.DB)

  if (ctx.actor.kind === "human") {
    const serverId = ctx.params?.id
    if (!serverId) return NextResponse.json({ error: "missing server id" }, { status: 400 })
    const auth = await requireServerMember(db, serverId, ctx.actor.userId)
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status })
    const visibleChannels = await queries.communityChannel.listServerChannelsForViewer(db, serverId, ctx.actor.userId)
    const search = req.nextUrl.searchParams
    const sidebarKeys = ["type", "parentType", "participating", "activeWithin", "limitPerParent", "retainId", "include"]
    const wantsSidebarThreads = sidebarKeys.some((key) => search.has(key))
    if (!wantsSidebarThreads) return NextResponse.json({ channels: visibleChannels })

    if (
      search.get("type") !== "thread" ||
      search.get("parentType") !== "forum" ||
      search.get("participating") !== "true" ||
      search.get("activeWithin") !== "72h" ||
      search.get("include") !== "parentMessage"
    ) {
      return NextResponse.json({ error: "invalid forum sidebar query" }, { status: 400 })
    }
    const rawLimit = search.get("limitPerParent")
    const limitPerParent = rawLimit && /^\d+$/.test(rawLimit) ? Number(rawLimit) : NaN
    if (!Number.isInteger(limitPerParent) || limitPerParent < 1 || limitPerParent > 5) {
      return NextResponse.json({ error: "limitPerParent must be between 1 and 5" }, { status: 400 })
    }
    const retainId = search.get("retainId")?.trim()
    if (search.has("retainId") && !retainId) {
      return NextResponse.json({ error: "retainId is required" }, { status: 400 })
    }

    const forumIds = visibleChannels.filter((channel) => isForum(channel.type)).map((channel) => channel.id)
    const serverNow = new Date().toISOString()
    const windowMs = 72 * 60 * 60 * 1000
    const activeAfter = new Date(Date.parse(serverNow) - windowMs).toISOString()
    const projection = await queries.communityThread.listParticipatingForumThreads(db, {
      parentChannelIds: forumIds,
      userId: ctx.actor.userId,
      activeAfter,
      limitPerParent,
      ...(retainId ? { retainId } : {}),
    })
    const rows = [...new Map(
      (projection.retained
        ? [...projection.canonical, projection.retained]
        : projection.canonical)
        .map((channel) => [channel.id, channel] as const),
    ).values()]
    const parentMessageIds = rows
      .map((channel) => channel.parentMessageId)
      .filter((id): id is string => !!id)
    const [parentMessages, unreadRows] = await Promise.all([
      queries.communityMessage.getMessagesByIds(db, parentMessageIds),
      queries.communityInbox.listUnreadChannels(db, ctx.actor.userId, rows.map((channel) => channel.id)),
    ])
    const unreadIds = new Set(unreadRows.map((row) => row.channelId))
    const projectChannel = (channel: (typeof rows)[number]) => ({
      ...channel,
      expiresAt: new Date(Date.parse(channel.activityAt) + windowMs).toISOString(),
      unread: unreadIds.has(channel.id),
    })
    const canonicalChannels = projection.canonical.map(projectChannel)
    const retainedChannel = projection.retained ? projectChannel(projection.retained) : null
    let channels = canonicalChannels
    if (
      retainedChannel?.parentChannelId &&
      !canonicalChannels.some((channel) => channel.id === retainedChannel.id)
    ) {
      const parentId = retainedChannel.parentChannelId
      channels = [
        ...canonicalChannels.filter((channel) => channel.parentChannelId !== parentId),
        ...canonicalChannels
          .filter((channel) => channel.parentChannelId === parentId)
          .slice(0, limitPerParent - 1),
        retainedChannel,
      ].sort((a, b) =>
        compareAsciiSqliteBinary(a.parentChannelId ?? "", b.parentChannelId ?? "") ||
        compareAsciiSqliteBinary(b.activityAt, a.activityAt) ||
        compareAsciiSqliteBinary(b.id, a.id)
      )
    }
    return NextResponse.json({
      channels,
      canonicalChannels,
      retainedChannel,
      included: { parentMessages },
      serverNow,
    })
  }

  const botUserId = ctx.actor.userId

  const serverRef = new URL(req.url).searchParams.get("server")
  if (!serverRef) {
    return NextResponse.json({ error: "missing server query param" }, { status: 400 })
  }
  if (!parseNameAndTag(serverRef)) {
    return NextResponse.json({ error: "invalid server handle, expected name#0042" }, { status: 400 })
  }

  const servers = await queries.communityServer.resolveServerByNameForMember(db, botUserId, serverRef)
  if (servers.length === 0) {
    return NextResponse.json({ error: `server not found: ${serverRef}` }, { status: 404 })
  }
  const groups = await buildServerChannelGroups(db, servers[0]!, botUserId)
  return NextResponse.json({ groups })
})
