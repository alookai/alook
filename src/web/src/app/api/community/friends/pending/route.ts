import { queries, readOrStale } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withCommunityActor } from "@/lib/middleware/community-actor"
import { writeJSON } from "@/lib/middleware/helpers"
import { avatarInitial } from "@/lib/community/avatar"

export const GET = withCommunityActor(async (_req, ctx) => {
  const db = getDb(ctx.env.DB)
  type PendingRow = Awaited<ReturnType<typeof queries.communityFriendship.listPending>>[number]
  const { value, stale } = await readOrStale<{ rows: PendingRow[] }>(
    async () => ({ rows: await queries.communityFriendship.listPending(db, ctx.userId) }),
    { rows: [] },
    { route: "community/friends/pending" },
  )
  // One row shape everywhere — no `source: 'bot'` tag (pass-as-human). An
  // outgoing row still gated on its owner renders a "Waiting on owner approval"
  // chip instead of a cancel affordance, keyed off `needsOwnerApproval`.
  const pending = value.rows.map((r) => ({
    id: r.id,
    userId: r.userId,
    name: r.name,
    discriminator: r.discriminator,
    avatar: r.image ?? avatarInitial(r.name),
    bio: r.aboutMe ?? null,
    statusEmoji: r.statusEmoji ?? null,
    statusText: r.statusText ?? null,
    kind: r.kind,
    needsOwnerApproval: r.needsOwnerApproval,
  }))
  return writeJSON(stale ? { pending, stale: true } : { pending })
})
