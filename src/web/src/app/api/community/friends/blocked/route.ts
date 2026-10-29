import { readCommunityResourceBundle } from "@/lib/community/attention-resources.server"
import { NextResponse, type NextRequest } from "next/server"
import { BUSINESS_SCHEMA_VERSION, CommunityBlockedFriendsReadSchema, type CommunityBlockedFriendsRead, queries, readOrStale } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withCommunityActor, rejectBot } from "@/lib/middleware/community-actor"

/**
 * GET /api/community/friends/blocked — the blocked bucket (route/disc trunk,
 * 接口树统一 轴3). Owner-only: a bot NEVER sees who its owner blocked.
 *
 * The bot exclusion is an ENDPOINT-level capability gate (Aigneis #408/#421,
 * Blondie #436): `rejectBot` returns 403 BEFORE any blocked-data query runs, so
 * the 403 is independent of whether/whom the caller blocked — zero existence
 * leak, a pure capability boundary (not a row-projection filter). The flat
 * `listFriends` verb never exposed blocked to bots; this keeps that invariant
 * while giving human a clean per-bucket read.
 */
export const GET = withCommunityActor(async (_req: NextRequest, ctx) => {
  const denied = rejectBot(ctx.actor)
  if (denied) return denied

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
