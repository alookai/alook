import { z } from "zod"

const profile = z.strictObject({
  id: z.string(),
  name: z.string(),
  discriminator: z.string(),
  image: z.string().nullable(),
  avatarVersion: z.number().int().nonnegative(),
})

export const FriendApprovalPayloadSchema = z.strictObject({
  friendshipId: z.string(),
  status: z.enum(["pending", "approved", "denied", "superseded", "cancelled"]),
  waitingOn: z.enum(["you", "other-owner", "addressee"]).nullable(),
  otherProfile: profile,
  botProfile: profile,
  waitingOnProfile: profile.nullable().optional(),
})

export type FriendApprovalPayload = z.infer<typeof FriendApprovalPayloadSchema>
export type FriendApprovalProfile = FriendApprovalPayload["otherProfile"]
