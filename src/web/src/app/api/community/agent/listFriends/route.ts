import { NextResponse, type NextRequest } from "next/server"
import { queries } from "@alook/shared"
import type { FriendCard } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAgentRunnerAuth } from "@/lib/middleware/community-agent-runner-auth"
import { wsDoFetch } from "@/lib/broadcast"

/**
 * POST /api/community/agent/listFriends — the bot's friends + pending, three
 * buckets, each entry a profile card. Never emits `isBot`.
 * See plans/agent-friendship-approval-gate.md §Route 2.
 */
export const POST = withAgentRunnerAuth(async (_req: NextRequest, ctx) => {
  const db = getDb(ctx.env.DB)

  const buckets = await queries.communityFriendship.listAgentFriends(db, ctx.botUserId)

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
        { label: ctx.botUserId },
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
