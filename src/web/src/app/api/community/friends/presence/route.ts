import { withAuth } from "@/lib/middleware/auth-policy"
import { queries, PRESENCE_MEMBER_CAP, readOrStale } from "@alook/shared"
import { getDb } from "@/lib/db"
import { humanAuthPolicy } from "@/lib/middleware/auth"
import { writeJSON } from "@/lib/middleware/helpers"
import { fetchUserPresence } from "@/lib/community/member-presence"

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
export const GET = withAuth(humanAuthPolicy, async (_req, ctx) => {
  const db = getDb(ctx.env.DB)
  // D1 read is fail-closed via `readOrStale`; a transient outage yields
  // `{ online: [] }` with `stale: true` rather than a 500.
  const { value, stale } = await readOrStale<{ friendIds: string[] }>(
    async () => {
      const allFriendIds = await queries.communityFriendship.getFriendUserIds(db, ctx.userId)
      // There's no enforced cap on friend count today — reuse the server
      // presence cap defensively so a pathological friend list can't blow past
      // `/presence/users`'s own 1000-id limit and fail the whole check.
      return { friendIds: allFriendIds.slice(0, PRESENCE_MEMBER_CAP) }
    },
    { friendIds: [] },
    { route: "community/friends/presence" },
  )

  const presence = stale ? undefined : await fetchUserPresence(ctx.env, value.friendIds, ctx.userId)
  return writeJSON(presence ?? { online: [], offline: [], stale: true })
})
