import { queries } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { requireServerMember } from "@/lib/community/permissions"
import { avatarInitial } from "@/lib/community/avatar"

/**
 * List the viewer's friends who are NOT already members of this server —
 * the invite dialog consumes this so already-joined friends don't clutter
 * the picker (or leave the inviter thinking they're "sending" a fresh invite).
 *
 * Membership must be checked server-side, not on the client: a stale friends
 * cache + a stale members cache would race and mis-classify. Here we scope
 * one query per side, subtract, and return the survivor set — the caller
 * gets the same `Friend`-row shape as /api/community/friends.
 */
export const GET = withAuth(async (_req, ctx) => {
  const serverId = ctx.params?.id
  if (!serverId) return writeError("missing server id", 400)

  const db = getDb(ctx.env.DB)
  const auth = await requireServerMember(db, serverId, ctx.userId)
  if (!auth.ok) return writeError(auth.error, auth.status)

  const [rawFriends, memberIds] = await Promise.all([
    queries.communityFriendship.listFriends(db, ctx.userId),
    queries.communityMember.listMemberUserIds(db, serverId),
  ])
  const memberSet = new Set(memberIds)

  const friends = rawFriends
    .filter((f) => !memberSet.has(f.friendUserId))
    .map((f) => ({
      id: f.id,
      userId: f.friendUserId,
      name: f.friendName,
      discriminator: f.friendDiscriminator,
      avatar: f.friendImage ?? avatarInitial(f.friendName),
      status: "offline" as const,
      sub: "",
    }))

  return writeJSON({ friends })
})
