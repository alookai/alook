import { z } from "zod"
import { CommunityChannelResourceSchema, CommunityMemberRelationSchema, CommunityMessageResourceSchema, CommunityResourceProfileSchema } from "./community-resources"

export const CommunityDmReadItemSchema = z.strictObject({
  id: CommunityChannelResourceSchema.shape.id,
  userId: CommunityResourceProfileSchema.shape.id,
  channel: CommunityChannelResourceSchema,
  profile: CommunityResourceProfileSchema,
  memberships: z.array(CommunityMemberRelationSchema).length(2),
  preview: z.string(),
  activityAt: CommunityChannelResourceSchema.shape.createdAt,
  unread: z.boolean(),
  lastUnreadSeq: CommunityMessageResourceSchema.shape.seq.optional(),
}).superRefine((dm, ctx) => {
  const users = new Set(dm.memberships.map(row => row.userId))
  if (dm.channel.id !== dm.id || dm.channel.type !== "dm" || dm.channel.serverId !== null || dm.channel.categoryId !== null || dm.channel.parentChannelId !== null || dm.channel.parentMessageId !== null
    || dm.profile.id !== dm.userId || users.size !== 2 || !users.has(dm.userId)
    || dm.memberships.some(row => row.channelId !== dm.id || row.relation !== "access")
    || dm.unread !== (dm.lastUnreadSeq !== undefined)) {
    ctx.addIssue({ code: "custom", message: "DM resource scope mismatch" })
  }
})

export const CommunityDmsReadSchema = z.strictObject({ conversations: z.array(CommunityDmReadItemSchema) }).superRefine((value, ctx) => {
  if (new Set(value.conversations.map(row => row.id)).size !== value.conversations.length) {
    ctx.addIssue({ code: "custom", message: "Duplicate DM resource identity" })
  }
})

export function parseCommunityDmsRead(value: unknown, viewerId: string) {
  const result = CommunityDmsReadSchema.parse(value)
  if (result.conversations.some(dm => dm.userId === viewerId || !dm.memberships.some(row => row.userId === viewerId))) {
    throw new Error("DM resource viewer mismatch")
  }
  return result
}

export type CommunityDmsRead = z.infer<typeof CommunityDmsReadSchema>
