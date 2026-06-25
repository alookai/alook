import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries } from "@alook/shared"
import { fanOutToServerMembers } from "@/lib/community/fanout"
import type { CommunityMemberJoin } from "@/lib/community/ws-events"

export const POST = withAuth(async (req, ctx) => {
  const token = ctx.params?.token
  if (!token) {
    return writeError("invite token is required", 400)
  }

  const db = getDb(ctx.env.DB)

  let result: Awaited<ReturnType<typeof queries.communityInvite.useInvite>>
  try {
    result = await queries.communityInvite.useInvite(db, token, ctx.userId)
  } catch (err: unknown) {
    // Unique constraint violation means user is already a member
    const message = err instanceof Error ? err.message : String(err)
    if (message.includes("UNIQUE") || message.includes("unique")) {
      return writeError("Already a member", 400)
    }
    throw err
  }

  if (!result) {
    return writeError("Invalid or expired invite", 400)
  }

  const memberEvent: CommunityMemberJoin = {
    type: "community:member.join",
    serverId: result.invite.serverId,
    member: {
      id: result.member.id,
      userId: result.member.userId,
      name: result.member.nickname ?? result.member.userId,
      role: result.member.role ?? "member",
      joinedAt: result.member.joinedAt,
    },
  }

  fanOutToServerMembers(
    result.invite.serverId,
    memberEvent,
    { excludeUserId: ctx.userId }
  ).catch(() => {})

  return writeJSON({ member: result.member, serverId: result.invite.serverId })
})
