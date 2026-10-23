import { z } from "zod"

export const channelReorderRequestSchema = z.strictObject({
  channelIds: z.array(z.string().min(1)).min(1).refine((ids) => new Set(ids).size === ids.length, "channelIds must be unique"),
  move: z.strictObject({ channelId: z.string().min(1), categoryId: z.string().min(1).nullable() }).optional(),
}).refine((request) => !request.move || request.channelIds.includes(request.move.channelId), "moved channel must be included in channelIds")

export type ChannelReorderRequest = z.infer<typeof channelReorderRequestSchema>
export type ChannelCategoryMove = NonNullable<ChannelReorderRequest["move"]>
