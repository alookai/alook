import { readCommunityResourceBundle } from "@/lib/community/attention-resources.server"
import { NextResponse, type NextRequest } from "next/server"
import { BUSINESS_SCHEMA_VERSION, CommunityAcceptedFriendsReadSchema, type CommunityAcceptedFriendsRead, queries, readOrStale } from "@alook/shared"
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
      buckets.accepted.map((r) => r.peerUserId),
      userId,
    )
    return NextResponse.json({ accepted: buckets.accepted.map((r) => toFriendCard(r, onlineSet)) })
  }

  const { value } = await readOrStale<CommunityAcceptedFriendsRead>(
    async () => {
      const rows = await queries.communityFriendship.listFriends(db, userId)
      const friends = rows.map(row => ({ id: row.id, userId: row.friendUserId, sub: "" }))
      const resources = await readCommunityResourceBundle(db, userId, { channelIds: [], profileIds: friends.map(row => row.userId) })
      return CommunityAcceptedFriendsReadSchema.parse({ contractVersion: BUSINESS_SCHEMA_VERSION, friends, resources })
    },
    CommunityAcceptedFriendsReadSchema.parse({ contractVersion: BUSINESS_SCHEMA_VERSION, friends: [], stale: true }),
    { route: "community/friends/accepted" },
  )
  return NextResponse.json(value)
})
