import { withAuth } from "@/lib/middleware/auth-policy"
import { NextRequest } from "next/server"
import { humanAuthPolicy } from "@/lib/middleware/auth"
import { writeJSON } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries, parseCommunityDmsRead, CommunityResourceProfileSchema, CommunityMemberRelationSchema, communityChannelResourceFromStorage } from "@alook/shared"
import { canonicalUserImage } from "@/lib/community/storage"

export const GET = withAuth(humanAuthPolicy, async (_req: NextRequest, ctx) => {
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
    channel: communityChannelResourceFromStorage(r.channel),
    profile: CommunityResourceProfileSchema.parse({ id: r.otherUserId, name: r.otherUserName, discriminator: r.otherUserDiscriminator, avatar: canonicalUserImage(r.otherUserId, r.otherUserImage, r.otherUserAvatarVersion), avatarVersion: r.otherUserAvatarVersion }),
    memberships: [
      CommunityMemberRelationSchema.parse({ channelId: r.id, userId: ctx.userId, relation: "access", source: r.selfSource, isCreator: r.channel?.creatorId === ctx.userId, role: null, memberId: null }),
      CommunityMemberRelationSchema.parse({ channelId: r.id, userId: r.otherUserId, relation: "access", source: r.peerSource, isCreator: r.channel?.creatorId === r.otherUserId, role: null, memberId: null }),
    ],
    userId: r.otherUserId,
    preview: "",
    activityAt: r.lastMessageAt ?? r.createdAt,
    unread: unreadByChannelId.has(r.id),
    ...(unreadByChannelId.has(r.id)
      ? { lastUnreadSeq: unreadByChannelId.get(r.id) }
      : {}),
  }))
  return writeJSON(parseCommunityDmsRead({ conversations }, ctx.userId))
})
