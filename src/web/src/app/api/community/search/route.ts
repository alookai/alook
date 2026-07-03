import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries, MIN_SEARCH_LENGTH, MAX_SEARCH_LENGTH } from "@alook/shared"
import {
  requireServerMember,
  requireChannelMember,
  requireDMParticipant,
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
    const results = await queries.communitySearch.searchMessagesInServer(db, {
      query: q,
      serverId,
    })
    return writeJSON({ results })
  }

  if (channelId) {
    const auth = await requireChannelMember(db, channelId, ctx.userId)
    if (!auth.ok) return writeError(auth.error, auth.status)
    const results = await queries.communitySearch.searchMessages(db, {
      query: q,
      channelId,
    })
    return writeJSON({ results })
  }

  // Block check is inherited from `requireDMParticipant` — do not re-inline.
  const auth = await requireDMParticipant(db, dmConversationId!, ctx.userId)
  if (!auth.ok) return writeError(auth.error, auth.status)
  const results = await queries.communitySearch.searchMessages(db, {
    query: q,
    dmConversationId: dmConversationId!,
  })
  return writeJSON({ results })
})
