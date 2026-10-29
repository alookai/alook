import { readCommunityResourceBundle } from "@/lib/community/attention-resources.server"
import { NextResponse, type NextRequest } from "next/server"
import { BUSINESS_SCHEMA_VERSION, CommunityPendingFriendsReadSchema, type CommunityPendingFriendsRead, queries, readOrStale } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withCommunityActor } from "@/lib/middleware/community-actor"
import { resolvePresence, toFriendCard } from "@/lib/community/friend-cards"

export const GET = withCommunityActor(async (_req: NextRequest, ctx) => {
  const db = getDb(ctx.env.DB)
  const userId = ctx.actor.userId

  if (ctx.actor.kind === "bot") {
    const buckets = await queries.communityFriendship.listAgentFriends(db, userId)
    const onlineSet = await resolvePresence(
      ctx.env,
      [...buckets.pendingIncoming, ...buckets.pendingOutgoing].map((r) => r.peerUserId),
      userId,
    )
    return NextResponse.json({
      pendingIncoming: buckets.pendingIncoming.map((r) => toFriendCard(r, onlineSet)),
      pendingOutgoing: buckets.pendingOutgoing.map((r) => toFriendCard(r, onlineSet)),
    })
  }

  const { value } = await readOrStale<CommunityPendingFriendsRead>(
    async () => {
      const rows = await queries.communityFriendship.listPending(db, userId)
      const pending = rows.map(row => ({ id: row.id, userId: row.userId, kind: row.kind, needsOwnerApproval: row.needsOwnerApproval }))
      const resources = await readCommunityResourceBundle(db, userId, { channelIds: [], profileIds: pending.map(row => row.userId) })
      return CommunityPendingFriendsReadSchema.parse({ contractVersion: BUSINESS_SCHEMA_VERSION, pending, resources })
    },
    CommunityPendingFriendsReadSchema.parse({ contractVersion: BUSINESS_SCHEMA_VERSION, pending: [], stale: true }),
    { route: "community/friends/pending" },
  )
  return NextResponse.json(value)
})
