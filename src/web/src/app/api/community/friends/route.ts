import { queries, readOrStale } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON } from "@/lib/middleware/helpers"
import { avatarInitial } from "@/lib/community/avatar"

export const GET = withAuth(async (_req, ctx) => {
  const db = getDb(ctx.env.DB)
  type FriendRow = Awaited<ReturnType<typeof queries.communityFriendship.listFriends>>[number]
  type BlockedRow = Awaited<ReturnType<typeof queries.communityFriendship.listBlocked>>[number]
  const { value, stale } = await readOrStale<{ rawFriends: FriendRow[]; rawBlocked: BlockedRow[] }>(
    async () => {
      const [rawFriends, rawBlocked] = await Promise.all([
        queries.communityFriendship.listFriends(db, ctx.userId),
        queries.communityFriendship.listBlocked(db, ctx.userId),
      ])
      return { rawFriends, rawBlocked }
    },
    { rawFriends: [], rawBlocked: [] },
    { route: "community/friends" },
  )
  const friends = value.rawFriends.map((f) => ({
    id: f.id,
    userId: f.friendUserId,
    name: f.friendName,
    discriminator: f.friendDiscriminator,
    avatar: f.friendImage ?? avatarInitial(f.friendName),
    status: "offline" as const,
    sub: "",
    statusEmoji: f.statusEmoji ?? null,
    statusText: f.statusText ?? "",
  }))
  const blocked = value.rawBlocked.map((b) => ({
    id: b.id,
    userId: b.blockedUserId,
    name: b.blockedName,
    avatar: b.blockedImage ?? avatarInitial(b.blockedName),
  }))
  return writeJSON(stale ? { friends, blocked, stale: true } : { friends, blocked })
})
