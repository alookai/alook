import { NextResponse, type NextRequest } from "next/server"
import { queries, readOrStale } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withCommunityActor } from "@/lib/middleware/community-actor"
import { avatarInitial } from "@/lib/community/avatar"
import { canonicalUserImage } from "@/lib/community/storage"
import { resolvePresence, toFriendCard } from "@/lib/community/friend-cards"

/**
 * GET /api/community/friends/accepted — the accepted-friends bucket (route/disc
 * trunk, 接口树统一 轴3, folds the flat `listFriends` verb's accepted bucket).
 *
 * Dual-actor, reading the SAME `communityFriendship` status='accepted' data,
 * projected by actor.kind (Blondie #436: one source of truth so the human
 * migration off the legacy aggregate GET /friends is later byte-consistent):
 *   - human → UI DTO (same shape GET /friends' `friends[]` emits today)
 *   - bot   → lean `FriendCard` + presence
 *
 * ①-C / users/me/* family invariant (Aigneis #426): scope is ALWAYS the caller's
 * own userId (ctx.actor.userId) — this endpoint takes NO target-user param, so a
 * bot can only ever read ITS OWN accepted friends, never probe another user's.
 */
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

  // Human arm — same accepted projection GET /friends emits today (the legacy
  // aggregate stays live this step; this endpoint is the migration target).
  type FriendRow = Awaited<ReturnType<typeof queries.communityFriendship.listFriends>>[number]
  const { value, stale } = await readOrStale<{ rows: FriendRow[] }>(
    async () => ({ rows: await queries.communityFriendship.listFriends(db, userId) }),
    { rows: [] },
    { route: "community/friends/accepted" },
  )
  const friends = value.rows.map((f) => ({
    id: f.id,
    userId: f.friendUserId,
    name: f.friendName,
    discriminator: f.friendDiscriminator,
    avatar: canonicalUserImage(f.friendUserId, f.friendImage, f.friendAvatarVersion)
      ?? avatarInitial(f.friendName),
    avatarVersion: f.friendAvatarVersion,
    status: "offline" as const,
    sub: "",
    statusEmoji: f.statusEmoji ?? null,
    statusText: f.statusText ?? "",
  }))
  return NextResponse.json(stale ? { friends, stale: true } : { friends })
})
