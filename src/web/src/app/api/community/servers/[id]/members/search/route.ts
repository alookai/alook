import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries, MAX_MEMBERS_PAGE_SIZE } from "@alook/shared"
import { requireServerMember } from "@/lib/community/permissions"
import { parseBoundedInt } from "@/lib/community/messages"
import { avatarInitial } from "@/lib/community/avatar"

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
  const members = rows.map((r) => {
    const display = r.nickname ?? r.userName ?? ""
    return {
      id: r.id,
      userId: r.userId,
      name: display,
      avatar: r.userImage ?? avatarInitial(display),
      status: (r.userId === ctx.userId ? "online" : "offline") as "online" | "offline",
      sub: "",
      role: r.role ?? "member",
    }
  })

  return writeJSON({ members, limit })
})
