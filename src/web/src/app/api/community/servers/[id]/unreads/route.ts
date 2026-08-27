import { NextResponse } from "next/server"
import { queries, readOrStale } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { requireServerMember } from "@/lib/community/permissions"

/** Attention-eligible read-state projection for one server's sidebar badges. */
export const GET = withAuth(async (_req, ctx) => {
  const serverId = ctx.params?.id
  if (!serverId) return NextResponse.json({ error: "missing server id" }, { status: 400 })

  const db = getDb(ctx.env.DB)
  const auth = await requireServerMember(db, serverId, ctx.userId)
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const { value, stale } = await readOrStale(
    async () => {
      const visibleChannelIds = await queries.communityChannel.listVisibleChannelIds(db, serverId, ctx.userId)
      const unread = await queries.communityInbox.listEligibleUnreadChannels(db, ctx.userId, visibleChannelIds)
      const forumParentIds = unread
        .filter((row) => !row.parentChannelId && row.type === "forum")
        .map((row) => row.channelId)
      const unreadOpeners = await queries.communityInbox.listUnreadForumOpeners(
        db,
        ctx.userId,
        forumParentIds,
      )
      const forumParentsWithUnread = new Set([
        ...unreadOpeners.map((row) => row.forumChannelId),
        ...unread.flatMap((row) => row.parentChannelId ? [row.parentChannelId] : []),
      ])
      const projectedUnread = unread.filter(
        (row) =>
          row.parentChannelId ||
          row.type !== "forum" ||
          forumParentsWithUnread.has(row.channelId),
      )
      return {
        channelIds: projectedUnread.map((row) => row.channelId),
        // Preserve the canonical child → parent attribution. The client needs
        // this even when a participating forum post is outside the sidebar's
        // 72h / top-five projection, otherwise a cold boot loses its unread
        // signal entirely. `listEligibleUnreadChannels` has already applied
        // access, archive, participant, read-cursor, and policy filtering;
        // the client narrows them to parents whose canonical type is `forum`.
        childChannels: projectedUnread.flatMap((row) => row.parentChannelId
          ? [{ id: row.channelId, parentChannelId: row.parentChannelId }]
          : []),
      }
    },
    { channelIds: [] as string[], childChannels: [] as Array<{ id: string; parentChannelId: string }> },
    { route: "community/servers/:id/unreads" },
  )

  return NextResponse.json({
    channelIds: value.channelIds,
    childChannels: value.childChannels,
    stale,
  })
})
