import { withAuth } from "@/lib/middleware/auth-policy"
import { readCommunityResourceBundle } from "@/lib/community/attention-resources.server"
import { NextResponse, type NextRequest } from "next/server"
import { BUSINESS_SCHEMA_VERSION, CommunityBlockedFriendsReadSchema, type CommunityBlockedFriendsRead, queries, readOrStale } from "@alook/shared"
import { getDb } from "@/lib/db"
import { communityActorPolicy, rejectBot } from "@/lib/middleware/community-actor"

/**
 * Deny bots before any blocked-data query, so the response cannot reveal
 * whether the owner blocked someone.
 */
export const GET = withAuth({
  ...communityActorPolicy(),
  authorize: (_req, ctx) => rejectBot(ctx.actor),
}, async (_req: NextRequest, ctx) => {

  const db = getDb(ctx.env.DB)
  const { value } = await readOrStale<CommunityBlockedFriendsRead>(
    async () => {
      const rows = await queries.communityFriendship.listBlocked(db, ctx.actor.userId)
      const blocked = rows.map(row => ({ id: row.id, userId: row.blockedUserId }))
      const resources = await readCommunityResourceBundle(db, ctx.actor.userId, { channelIds: [], profileIds: blocked.map(row => row.userId) })
      return CommunityBlockedFriendsReadSchema.parse({ contractVersion: BUSINESS_SCHEMA_VERSION, blocked, resources })
    },
    CommunityBlockedFriendsReadSchema.parse({ contractVersion: BUSINESS_SCHEMA_VERSION, blocked: [], stale: true }),
    { route: "community/friends/blocked" },
  )
  return NextResponse.json(value)
})
