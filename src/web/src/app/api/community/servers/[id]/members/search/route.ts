import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries, MAX_MEMBERS_PAGE_SIZE } from "@alook/shared"
import { requireServerMember } from "@/lib/community/permissions"
import { parseBoundedInt } from "@/lib/community/messages"
import { mapMemberForApi } from "@/lib/community/member-payload"

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

  const rows = await queries.communityMember.searchMembers(db, serverId, q, { limit })
  // No bot gating here — `searchMembers` never selected the bot columns and this
  // route never emitted `isBot`/`ownerUserId`. Byte-identical to before.
  const members = rows.map((r) => mapMemberForApi(r, ctx.userId))

  return writeJSON({ members, limit })
})
