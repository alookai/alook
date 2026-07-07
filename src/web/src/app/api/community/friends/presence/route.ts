import { queries, PRESENCE_MEMBER_CAP } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON } from "@/lib/middleware/helpers"
import { wsDoFetch } from "@/lib/broadcast"

/**
 * Bulk online-status check for the caller's own friends.
 *
 * Presence is WS-connection-based (see `ws-do`'s `WebSocketDurableObject`),
 * so it can't be answered from D1 — this fans out to the `ws-do` worker's
 * generic `/presence/users` endpoint the same way
 * `servers/[id]/presence/route.ts` does for server members. The friend id
 * list is looked up server-side from `ctx.userId` — callers can never pass
 * in arbitrary ids to probe someone else's presence.
 */
export const GET = withAuth(async (_req, ctx) => {
  const db = getDb(ctx.env.DB)
  const allFriendIds = await queries.communityFriendship.getFriendUserIds(db, ctx.userId)
  // There's no enforced cap on friend count today — reuse the server
  // presence cap defensively so a pathological friend list can't blow past
  // `/presence/users`'s own 1000-id limit and fail the whole check.
  const friendIds = allFriendIds.slice(0, PRESENCE_MEMBER_CAP)

  let online: string[] = []
  if (friendIds.length > 0) {
    try {
      const resp = await wsDoFetch(ctx.env, "/presence/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: friendIds }),
      }, { label: ctx.userId })
      if (resp.ok) {
        const data = await resp.json() as { online: string[] }
        online = Array.isArray(data.online) ? data.online : []
      }
    } catch { /* skip */ }
  }

  return writeJSON({ online })
})
