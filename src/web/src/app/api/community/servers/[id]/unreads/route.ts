import { NextResponse } from "next/server"
import { queries, readOrStale } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { requireServerMember } from "@/lib/community/permissions"

/**
 * Raw read-state projection for one server. Unlike the inbox notification
 * feed, this resource deliberately does not apply notification preferences:
 * muting a server/channel must not turn its sidebar read-state badge off.
 */
export const GET = withAuth(async (_req, ctx) => {
  const serverId = ctx.params?.id
  if (!serverId) return NextResponse.json({ error: "missing server id" }, { status: 400 })

  const db = getDb(ctx.env.DB)
  const auth = await requireServerMember(db, serverId, ctx.userId)
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const { value, stale } = await readOrStale(
    async () => {
      const visibleChannelIds = await queries.communityChannel.listVisibleChannelIdsForUser(db, ctx.userId)
      const unread = (await queries.communityInbox.listUnreadChannels(db, ctx.userId, visibleChannelIds))
        .filter((row) => row.serverId === serverId)
      return {
        channelIds: unread.map((row) => row.channelId),
        // Preserve the canonical child → parent attribution. The client needs
        // this even when a participating forum post is outside the sidebar's
        // 72h / top-five projection, otherwise a cold boot loses its unread
        // signal entirely. `listUnreadChannels` has already applied access,
        // archive, and participant filtering, so these are safe candidates;
        // the client narrows them to parents whose canonical type is `forum`.
        childChannels: unread.flatMap((row) => row.parentChannelId
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
