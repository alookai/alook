import { NextResponse, type NextRequest } from "next/server"
import { queries, readOrStale } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withCommunityActor, rejectBot } from "@/lib/middleware/community-actor"
import { avatarInitial } from "@/lib/community/avatar"
import { canonicalUserImage } from "@/lib/community/storage"

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
  type BlockedRow = Awaited<ReturnType<typeof queries.communityFriendship.listBlocked>>[number]
  const { value, stale } = await readOrStale<{ rows: BlockedRow[] }>(
    async () => ({ rows: await queries.communityFriendship.listBlocked(db, ctx.actor.userId) }),
    { rows: [] },
    { route: "community/friends/blocked" },
  )
  const blocked = value.rows.map((b) => ({
    id: b.id,
    userId: b.blockedUserId,
    name: b.blockedName,
    avatar: canonicalUserImage(b.blockedUserId, b.blockedImage, b.blockedAvatarVersion)
      ?? avatarInitial(b.blockedName),
    avatarVersion: b.blockedAvatarVersion,
  }))
  return NextResponse.json(stale ? { blocked, stale: true } : { blocked })
})
