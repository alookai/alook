import { queries, readOrStale } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON } from "@/lib/middleware/helpers"
import { avatarInitial } from "@/lib/community/avatar"

export const GET = withAuth(async (_req, ctx) => {
  const db = getDb(ctx.env.DB)
  type PendingRow = Awaited<ReturnType<typeof queries.communityFriendship.listPending>>[number]
  const { value, stale } = await readOrStale<{ rows: PendingRow[] }>(
    async () => ({ rows: await queries.communityFriendship.listPending(db, ctx.userId) }),
    { rows: [] },
    { route: "community/friends/pending" },
  )
  const pending = value.rows.map((r) => ({
    id: r.id,
    userId: r.userId,
    name: r.name,
    avatar: r.image ?? avatarInitial(r.name),
    kind: r.kind,
  }))
  return writeJSON(stale ? { pending, stale: true } : { pending })
})
