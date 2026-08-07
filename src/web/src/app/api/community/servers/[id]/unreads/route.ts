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
      const unread = await queries.communityInbox.listUnreadChannels(db, ctx.userId, visibleChannelIds)
      return { channelIds: unread.filter((row) => row.serverId === serverId).map((row) => row.channelId) }
    },
    { channelIds: [] as string[] },
    { route: "community/servers/:id/unreads" },
  )

  return NextResponse.json({ channelIds: value.channelIds, stale })
})
