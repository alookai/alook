import { withAuth } from "@/lib/middleware/auth-policy"
import { readCommunityResourceBundle } from "@/lib/community/attention-resources.server"
import { NextResponse, type NextRequest } from "next/server"
import { BUSINESS_SCHEMA_VERSION, CommunityAcceptedFriendsReadSchema, type CommunityAcceptedFriendsRead, queries, readOrStale } from "@alook/shared"
import { getDb } from "@/lib/db"
import { communityActorPolicy } from "@/lib/middleware/community-actor"
import { resolvePresence, toFriendCard } from "@/lib/community/friend-cards"
import { requireServerMember } from "@/lib/community/permissions"
import { writeError } from "@/lib/middleware/helpers"

export const GET = withAuth(communityActorPolicy(), async (req: NextRequest, ctx) => {
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

  const excludeServerId = req.nextUrl.searchParams.get("excludeServerId")?.trim() || null
  if (excludeServerId) {
    const auth = await requireServerMember(db, excludeServerId, userId)
    if (!auth.ok) return writeError(auth.error, auth.status)
  }

  const { value } = await readOrStale<CommunityAcceptedFriendsRead>(
    async () => {
      const rows = await queries.communityFriendship.listFriends(db, userId)
      const totalFriends = rows.length
      let filtered = rows
      if (excludeServerId && rows.length > 0) {
        const existing = await queries.communityMember.getMembersByUserIds(
          db,
          excludeServerId,
          rows.map((row) => row.friendUserId),
        )
        const existingUserIds = new Set(existing.map((member) => member.userId))
        filtered = rows.filter((row) => !existingUserIds.has(row.friendUserId))
      }
      const friends = filtered.map(row => ({ id: row.id, userId: row.friendUserId, sub: "" }))
      const resources = await readCommunityResourceBundle(db, userId, { channelIds: [], profileIds: friends.map(row => row.userId) })
      return CommunityAcceptedFriendsReadSchema.parse({
        contractVersion: BUSINESS_SCHEMA_VERSION,
        friends,
        resources,
        ...(excludeServerId ? { totalFriends } : {}),
      })
    },
    CommunityAcceptedFriendsReadSchema.parse({ contractVersion: BUSINESS_SCHEMA_VERSION, friends: [], stale: true }),
    { route: "community/friends/accepted" },
  )
  return NextResponse.json(value)
})
