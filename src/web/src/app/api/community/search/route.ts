import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries, withD1Retry, MIN_SEARCH_LENGTH, MAX_SEARCH_LENGTH } from "@alook/shared"
import {
  requireServerMember,
  requireChannelMember,
  requireDMAccess,
} from "@/lib/community/permissions"

export const GET = withAuth(async (req: NextRequest, ctx) => {
  const url = new URL(req.url)
  const q = url.searchParams.get("q")?.trim()
  const serverId = url.searchParams.get("serverId")
  const channelId = url.searchParams.get("channelId")
  const dmConversationId = url.searchParams.get("dmConversationId")

  if (!q) return writeError("query parameter q is required", 400)
  if (q.length < MIN_SEARCH_LENGTH) {
    return writeError(`query must be at least ${MIN_SEARCH_LENGTH} characters`, 400)
  }
  if (q.length > MAX_SEARCH_LENGTH) {
    return writeError(`query must be ≤ ${MAX_SEARCH_LENGTH} characters`, 400)
  }
  if (!serverId && !channelId && !dmConversationId) {
    return writeError("a scope parameter (serverId, channelId, or dmConversationId) is required", 400)
  }

  const db = getDb(ctx.env.DB)

  if (serverId) {
    const auth = await requireServerMember(db, serverId, ctx.userId)
    if (!auth.ok) return writeError(auth.error, auth.status)
    // Scope to the viewer's visible channels so private-channel content never
    // surfaces in server-wide search.
    // `withD1Retry` (D1-armor: no-fallback search read; retry to truth, never a
    // misleading empty result-set). Visible-channel scope + search as one unit.
    const results = await withD1Retry(
      async () => {
        const visibleChannelIds = await queries.communityChannel.listVisibleChannelIds(
          db,
          serverId,
          ctx.userId,
        )
        return queries.communitySearch.searchMessagesInServer(db, {
          query: q,
          serverId,
          visibleChannelIds,
        })
      },
      { route: "search/server" },
    )
    return writeJSON({ results })
  }

  if (channelId) {
    const auth = await requireChannelMember(db, channelId, ctx.userId)
    if (!auth.ok) return writeError(auth.error, auth.status)
    const results = await withD1Retry(
      () => queries.communitySearch.searchMessages(db, { query: q, channelId }),
      { route: "search/channel" },
    )
    return writeJSON({ results })
  }

  // A DM is a `type=dm` channel now; the `dmConversationId` query param IS the
  // DM's channel id. Block check is inherited from `requireDMAccess` — do not
  // re-inline.
  const auth = await requireDMAccess(db, dmConversationId!, ctx.userId)
  if (!auth.ok) return writeError(auth.error, auth.status)
  const results = await withD1Retry(
    () => queries.communitySearch.searchMessages(db, { query: q, channelId: dmConversationId! }),
    { route: "search/dm" },
  )
  return writeJSON({ results })
})
