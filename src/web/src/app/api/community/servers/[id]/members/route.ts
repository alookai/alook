import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import {
  queries,
  DEFAULT_MEMBERS_PAGE_SIZE,
  MAX_MEMBERS_PAGE_SIZE,
} from "@alook/shared"
import { requireServerMember } from "@/lib/community/permissions"
import { parseBoundedInt } from "@/lib/community/messages"

export const GET = withAuth(async (req, ctx) => {
  const serverId = ctx.params?.id
  if (!serverId) return writeError("missing server id", 400)

  const db = getDb(ctx.env.DB)
  const auth = await requireServerMember(db, serverId, ctx.userId)
  if (!auth.ok) return writeError(auth.error, auth.status)

  const url = new URL(req.url)
  const limit = parseBoundedInt(
    url.searchParams.get("limit"),
    DEFAULT_MEMBERS_PAGE_SIZE,
    MAX_MEMBERS_PAGE_SIZE,
  )

  // Paginate in memory until the query module gains cursor support — the
  // shared `listMembers` already scopes by serverId, so this is safe but not
  // ideal for very large servers (>10k members). Tracking work to push the
  // limit into Drizzle as a follow-up.
  const rows = (await queries.communityMember.listMembers(db, serverId)).slice(0, limit)
  const members = rows.map((r) => ({
    id: r.id,
    userId: r.userId,
    name: r.nickname ?? r.userName ?? r.userEmail ?? "Unknown",
    avatar: r.userImage ?? (r.userName ?? "?").charAt(0).toUpperCase(),
    status: (r.userId === ctx.userId ? "online" : "offline") as "online" | "offline",
    sub: "",
    role: r.role ?? "member",
  }))
  return writeJSON({ members, limit })
})
