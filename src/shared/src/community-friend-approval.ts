import { z } from "zod"
import { CommunityResourceProfileSchema } from "./community-profile-resource"

const identity = CommunityResourceProfileSchema.pick({ id: true, name: true, discriminator: true, avatarVersion: true })
const profile = identity.extend({ image: CommunityResourceProfileSchema.shape.avatar })

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
