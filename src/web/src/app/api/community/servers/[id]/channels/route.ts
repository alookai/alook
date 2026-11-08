import { withAuth } from "@/lib/middleware/auth-policy"
import { communityChannelResourceFromStorage } from "@alook/shared"
import { FORUM_SIDEBAR_MAX_PER_PARENT, FORUM_SIDEBAR_ACTIVE_WITHIN, FORUM_SIDEBAR_ACTIVITY_WINDOW_MS, BUSINESS_SCHEMA_VERSION, CommunityForumSidebarChannelSummarySchema, CommunityForumSidebarEnvelopeSchema } from "@alook/shared"
import { readCommunityResourceBundle } from "@/lib/community/attention-resources.server"
import { NextResponse, NextRequest } from "next/server"
import { supportsSidebarThreads } from "@/lib/community/forum-sidebar"
import { getDb } from "@/lib/db"
import { compareAsciiSqliteBinary, parseNameAndTag, queries } from "@alook/shared"
import { communityActorPolicy } from "@/lib/middleware/community-actor"
import { buildServerChannelGroups } from "@/lib/community/list-channels"
import { requireServerMember } from "@/lib/community/permissions"
import { readCommunityServerChannelRows } from "@/lib/community/server-directory.server"

/**
 * Member-scoped bot resolution masks inaccessible servers as404. Channel
 * projection must also exclude private categories the bot cannot access.
 */
export const GET = withAuth(communityActorPolicy(), async (req: NextRequest, ctx) => {
  const db = getDb(ctx.env.DB)

  if (ctx.actor.kind === "human") {
    const serverId = ctx.params?.id
    if (!serverId) return NextResponse.json({ error: "missing server id" }, { status: 400 })
    const auth = await requireServerMember(db, serverId, ctx.actor.userId)
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status })
    const visibleChannels = await readCommunityServerChannelRows(db, serverId, ctx.actor.userId)
    const search = req.nextUrl.searchParams
    const sidebarKeys = ["type", "parentType", "participating", "activeWithin", "limitPerParent", "retainId", "include"]
    const wantsSidebarThreads = sidebarKeys.some((key) => search.has(key))
    if (!wantsSidebarThreads) return NextResponse.json({ channels: visibleChannels.map(communityChannelResourceFromStorage) })

    if (
      search.get("type") !== "thread" ||
      !["forum", "forum,text"].includes(search.get("parentType") ?? "") ||
      search.get("participating") !== "true" ||
      search.get("activeWithin") !== FORUM_SIDEBAR_ACTIVE_WITHIN ||
      search.get("include") !== "parentMessage"
    ) {
      return NextResponse.json({ error: "invalid thread sidebar query" }, { status: 400 })
    }
    const rawLimit = search.get("limitPerParent")
    const limitPerParent = rawLimit && /^\d+$/.test(rawLimit) ? Number(rawLimit) : NaN
    if (!Number.isInteger(limitPerParent) || limitPerParent < 1 || limitPerParent > FORUM_SIDEBAR_MAX_PER_PARENT) {
      return NextResponse.json({ error: `limitPerParent must be between 1 and ${FORUM_SIDEBAR_MAX_PER_PARENT}` }, { status: 400 })
    }
    const retainId = search.get("retainId")?.trim()
    if (search.has("retainId") && !retainId) {
      return NextResponse.json({ error: "retainId is required" }, { status: 400 })
    }

    const parentIds = visibleChannels.filter((channel) =>
      supportsSidebarThreads(channel.type) && (search.get("parentType") !== "forum" || channel.type === "forum")
    ).map((channel) => channel.id)
    const serverNow = new Date().toISOString()
    const windowMs = FORUM_SIDEBAR_ACTIVITY_WINDOW_MS
    const activeAfter = new Date(Date.parse(serverNow) - windowMs).toISOString()
    const projection = await queries.communityThread.listParticipatingForumThreads(db, {
      parentChannelIds: parentIds,
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
    const [resources, unreadRows] = await Promise.all([
      readCommunityResourceBundle(db, ctx.actor.userId, { channelIds: [...parentIds, ...rows.map(row => row.id)], messageIds: parentMessageIds, serverIds: [serverId] }),
      queries.communityInbox.listEligibleUnreadChannels(db, ctx.actor.userId, rows.map((channel) => channel.id)),
    ])
    const unreadIds = new Set(unreadRows.map((row) => row.channelId))
    const projectChannel = (channel: (typeof rows)[number]) => CommunityForumSidebarChannelSummarySchema.strip().parse({
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
    return NextResponse.json(CommunityForumSidebarEnvelopeSchema.parse({
      schemaVersion: BUSINESS_SCHEMA_VERSION, serverId, resources,
      channels,
      canonicalChannels,
      retainedChannel,
      retainedDisposition: projection.retainedDisposition,
      serverNow,
    }))
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
