import { NextResponse, type NextRequest } from "next/server"
import { queries } from "@alook/shared"
import type { FriendCard } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withCommunityActor, requireBot } from "@/lib/middleware/community-actor"
import { wsDoFetch } from "@/lib/broadcast"

/**
 * POST /api/community/listFriends — moved from /api/community/agent/listFriends
 * (plan §4, §9 phase 4). MOVE-FLAT, not FOLD onto GET /friends: the bot's
 * friend list has DIFFERENT semantics from the human's — it aggregates three
 * buckets (accepted + pendingOutgoing + pendingIncoming) with presence via
 * `listAgentFriends`, whereas the human GET /friends returns accepted + blocked
 * (pending is a separate /friends/pending route). Per the plan's judgment rule
 * (Melly #113: different semantics → keep distinct under the unified actor,
 * bot-gated), and matching batch1 which also kept listFriends as a distinct RPC.
 * Bot-only → human actor rejected 403. Never emits `isBot`. Body unchanged from
 * the /agent original except wrapper + identity source.
 */
export const POST = withCommunityActor(async (_req: NextRequest, ctx) => {
  const gate = requireBot(ctx.actor)
  if (!gate.ok) return gate.response
  const botUserId = gate.bot.userId

  const db = getDb(ctx.env.DB)

  const buckets = await queries.communityFriendship.listAgentFriends(db, botUserId)

  // Presence is WS-connection-based (see friends/presence route) — one bulk
  // check across every peer id in every bucket.
  const allPeerIds = [
    ...buckets.accepted,
    ...buckets.pendingOutgoing,
    ...buckets.pendingIncoming,
  ].map((r) => r.peerUserId)
  const uniquePeerIds = [...new Set(allPeerIds)]
  let onlineSet = new Set<string>()
  if (uniquePeerIds.length > 0) {
    try {
      const resp = await wsDoFetch(
        ctx.env,
        "/presence/users",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids: uniquePeerIds }),
        },
        { label: botUserId },
      )
      if (resp.ok) {
        const data = (await resp.json()) as { online: string[] }
        if (Array.isArray(data.online)) onlineSet = new Set(data.online)
      }
    } catch {
      /* presence best-effort — default everyone offline */
    }
  }

  const toCard = (r: (typeof buckets.accepted)[number]): FriendCard => ({
    userId: r.peerUserId,
    handle: `${r.name}#${r.discriminator}`,
    name: r.name,
    bio: r.aboutMe ?? null,
    statusText: r.statusText ?? null,
    statusEmoji: r.statusEmoji ?? null,
    presence: onlineSet.has(r.peerUserId) ? "online" : "offline",
  })

  return NextResponse.json({
    accepted: buckets.accepted.map(toCard),
    pendingOutgoing: buckets.pendingOutgoing.map(toCard),
    pendingIncoming: buckets.pendingIncoming.map(toCard),
  })
})
