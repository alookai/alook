import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries } from "@alook/shared"
import { requireChannelAccess } from "@/lib/community/permissions"
import { avatarInitial } from "@/lib/community/avatar"

/**
 * Server members who are NOT yet in this private-category channel — backs the
 * "add members" picker. Only creator/admins (canManage) may see it. Scoped by
 * subtracting the channel roster from the server member list server-side (a
 * stale client cache can't leak the wrong set).
 */
export const GET = withAuth(async (_req: NextRequest, ctx) => {
  const channelId = ctx.params?.id
  if (!channelId) return writeError("missing channel id", 400)

  const db = getDb(ctx.env.DB)
  const access = await requireChannelAccess(db, channelId, ctx.userId)
  if (!access.ok) return writeError(access.error, access.status)
  if (!access.value.canManage) return writeError("forbidden", 403)

  const channel = access.value.channel
  const [members, channelMemberIds] = await Promise.all([
    queries.communityMember.listMembers(db, channel.serverId),
    queries.communityChannel.listChannelMemberUserIds(db, channelId),
  ])
  const inChannel = new Set(channelMemberIds)
  if (channel.creatorId) inChannel.add(channel.creatorId)

  const addable = members
    .filter((m) => !inChannel.has(m.userId))
    .map((m) => ({
      userId: m.userId,
      name: m.userName,
      discriminator: m.discriminator,
      avatar: m.userImage ?? avatarInitial(m.userName ?? ""),
    }))

  return writeJSON({ members: addable })
})
