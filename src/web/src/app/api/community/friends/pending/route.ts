import { NextResponse, type NextRequest } from "next/server"
import { queries, readOrStale } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withCommunityActor } from "@/lib/middleware/community-actor"
import { avatarInitial } from "@/lib/community/avatar"
import { resolvePresence, toFriendCard } from "@/lib/community/friend-cards"

/**
 * GET /api/community/friends/pending — the pending-requests bucket (route/disc
 * trunk, 接口树统一 轴3). Was human-only (withAuth); now dual-actor, folding the
 * flat `listFriends` verb's pendingIncoming/pendingOutgoing buckets for the bot.
 * Both arms read the SAME `communityFriendship` status='pending' data, projected
 * by actor.kind (Blondie #436 single-source-of-truth):
 *   - human → the pending-page DTO (one `pending[]` with a `kind` in|out tag),
 *     UNCHANGED from before this fold (byte-identical for the web client).
 *   - bot   → the two directional buckets `{ pendingIncoming, pendingOutgoing }`
 *     as lean FriendCards + presence (the shape `alook friend list` composes).
 *
 * ①-C / users/me/* family invariant (Aigneis #426): NO target-user param — a
 * bot only ever reads its own pending set (scope = ctx.actor.userId).
 */
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

  // Human arm — byte-identical to the pre-fold human pending route.
  type PendingRow = Awaited<ReturnType<typeof queries.communityFriendship.listPending>>[number]
  const { value, stale } = await readOrStale<{ rows: PendingRow[] }>(
    async () => ({ rows: await queries.communityFriendship.listPending(db, userId) }),
    { rows: [] },
    { route: "community/friends/pending" },
  )
  // One row shape everywhere — no `source: 'bot'` tag (pass-as-human). An
  // outgoing row still gated on its owner renders a "Waiting on owner approval"
  // chip instead of a cancel affordance, keyed off `needsOwnerApproval`.
  const pending = value.rows.map((r) => ({
    id: r.id,
    userId: r.userId,
    name: r.name,
    avatar: r.image ?? avatarInitial(r.name),
    kind: r.kind,
    needsOwnerApproval: r.needsOwnerApproval,
  }))
  return NextResponse.json(stale ? { pending, stale: true } : { pending })
})
