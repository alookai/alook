import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries, MAX_MEMBERS_PAGE_SIZE } from "@alook/shared"
import { requireServerMember } from "@/lib/community/permissions"
import { parseBoundedInt } from "@/lib/community/messages"
import { mapMemberForApi } from "@/lib/community/member-payload"
import {
  encodeMemberSearchCursor,
  parseMemberSearchCursor,
} from "@/lib/community/member-search-cursor"

export const GET = withAuth(async (req, ctx) => {
  const serverId = ctx.params?.id
  if (!serverId) return writeError("missing server id", 400)

  const db = getDb(ctx.env.DB)
  const auth = await requireServerMember(db, serverId, ctx.userId)
  if (!auth.ok) return writeError(auth.error, auth.status)

  const url = new URL(req.url)
  const q = url.searchParams.get("q")?.trim() ?? ""
  if (q.length < 1) return writeError("q required", 400)

  const limit = parseBoundedInt(
    url.searchParams.get("limit"),
    MAX_MEMBERS_PAGE_SIZE,
    MAX_MEMBERS_PAGE_SIZE,
  )
  const cursor = parseMemberSearchCursor(
    url.searchParams.get("cursor"),
    { serverId, query: q },
  )
  if (cursor === null) return writeError("invalid cursor", 400)

  const page = await queries.communityMember.searchMembers(db, serverId, q, {
    limit,
    cursor,
  })
  // No bot gating here — `searchMembers` never selected the bot columns and this
  // route never emitted `isBot`/`ownerUserId`. Byte-identical to before.
  const members = page.members.map((r) => mapMemberForApi(r, ctx.userId))
  const nextCursor = page.cursor
    ? encodeMemberSearchCursor({
        serverId,
        query: q,
        name: page.cursor.name,
        id: page.cursor.id,
      })
    : undefined

  return writeJSON({ members, limit, hasMore: page.hasMore, cursor: nextCursor })
})
