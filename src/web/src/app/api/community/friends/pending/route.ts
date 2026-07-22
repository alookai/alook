import { queries, readOrStale } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON } from "@/lib/middleware/helpers"
import { avatarInitial } from "@/lib/community/avatar"

export const GET = withAuth(async (_req, ctx) => {
  const db = getDb(ctx.env.DB)
  type PendingRow = Awaited<ReturnType<typeof queries.communityFriendship.listPending>>[number]
  type BotRow = Awaited<ReturnType<typeof queries.communityBot.listPendingFriendRequestsByRequester>>[number]
  const { value, stale } = await readOrStale<{ rows: PendingRow[]; botRows: BotRow[] }>(
    async () => ({
      rows: await queries.communityFriendship.listPending(db, ctx.userId),
      botRows: await queries.communityBot.listPendingFriendRequestsByRequester(db, ctx.userId),
    }),
    { rows: [], botRows: [] },
    { route: "community/friends/pending" },
  )
  const pending = [
    ...value.rows.map((r) => ({
      id: r.id,
      userId: r.userId,
      name: r.name,
      avatar: r.image ?? avatarInitial(r.name),
      kind: r.kind,
      source: "friend" as const,
    })),
    // Outgoing bot friend-requests live in community_bot_approval_request (not
    // community_friendship); `id` is the approval-request id, cancelled via the
    // requester-side bot-cancel endpoint.
    ...value.botRows.map((r) => ({
      id: r.id,
      userId: r.botUserId,
      name: r.name,
      avatar: r.image ?? avatarInitial(r.name),
      kind: "outgoing" as const,
      source: "bot" as const,
    })),
  ]
  return writeJSON(stale ? { pending, stale: true } : { pending })
})
