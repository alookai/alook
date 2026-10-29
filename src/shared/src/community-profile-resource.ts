import { z } from "zod"

export const CommunityResourceProfileSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string(),
  discriminator: z.string().min(1),
  avatar: z.string().nullable(),
  avatarVersion: z.number().int().nonnegative(),
  aboutMe: z.string().optional(),
  bannerColor: z.string().nullable().optional(),
  kind: z.enum(["human", "bot"]).optional(),
  ownerUserId: z.string().min(1).nullable().optional(),
  ownerHandle: z.string().nullable().optional(),
  mutualServers: z.number().int().nonnegative().optional(),
  ownedByViewer: z.boolean().optional(),
  statusEmoji: z.string().nullable().optional(),
  statusText: z.string().nullable().optional(),
})
