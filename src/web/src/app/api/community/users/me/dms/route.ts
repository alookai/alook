import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries } from "@alook/shared"
import { avatarInitial } from "@/lib/community/avatar"
import { canonicalUserImage } from "@/lib/community/storage"

/**
 * GET /api/community/users/me/dms — the DM sidebar list, relocated from the
 * flat `GET /api/community/dm` (route/disc 接口树统一, Blondie #615/#432 terminal
 * table: RELOCATE into the users/me/* family, same class as inbox/marks/
 * server-folders — "my own" aggregate read, self-scope, no target-user param).
 * Byte-identical body to the former GET /dm handler; only the URL moved.
 *
 * DM channels carry server_id = NULL (no server to hang a `servers/{id}/…`
 * listing off), so this doesn't fit the channels/servers resource tree — it's
 * "the DM channels I'm a participant in", which is exactly the users/me/*
 * shape. POST (DM creation) already lives in the create-door (POST /channels
 * type: dm via createDmForUser) and needs no change here.
 */
export const GET = withAuth(async (_req: NextRequest, ctx) => {
  const db = getDb(ctx.env.DB)
  const [rows, unreadRows] = await Promise.all([
    queries.communityDm.listDMs(db, ctx.userId),
    queries.communityInbox.listEligibleUnreadDms(db, ctx.userId),
  ])
  const unreadByChannelId = new Map(
    unreadRows.map((row) => [row.channelId, row.lastUnreadSeq]),
  )
  const conversations = rows.map((r) => ({
    id: r.id,
    userId: r.otherUserId,
    name: r.otherUserName,
    discriminator: r.otherUserDiscriminator,
    avatar: canonicalUserImage(r.otherUserId, r.otherUserImage, r.otherUserAvatarVersion)
      ?? avatarInitial(r.otherUserName),
    avatarVersion: r.otherUserAvatarVersion,
    status: "offline" as const,
    preview: "",
    unread: unreadByChannelId.has(r.id),
    ...(unreadByChannelId.has(r.id)
      ? { lastUnreadSeq: unreadByChannelId.get(r.id) }
      : {}),
  }))
  return writeJSON({ conversations })
})
