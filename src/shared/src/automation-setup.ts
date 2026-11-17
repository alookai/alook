import { z } from "zod"
import { CommunityBotCreateRequestSchema } from "./schemas"
import { MAX_MESSAGE_CONTENT_LENGTH, MAX_SERVER_DESCRIPTION_LENGTH, MAX_SERVER_NAME_LENGTH } from "./constants/community"

export const AUTOMATION_SETUP_PERMISSIONS = ["bot.create", "server.create", "server.invite", "message.send"] as const

export const AutomationSetupNewBotSchema = CommunityBotCreateRequestSchema.omit({ runtime: true, image: true }).extend({
  backendId: z.string().trim().min(1).max(64),
}).strict()

export const AutomationSetupInputSchema = z.strictObject({
  server: z.strictObject({ name: z.string().trim().min(1).max(MAX_SERVER_NAME_LENGTH), description: z.string().max(MAX_SERVER_DESCRIPTION_LENGTH).optional() }),
  bots: z.array(z.union([AutomationSetupNewBotSchema, z.strictObject({ existingBotId: z.string().min(1).max(128) })])).min(1).max(3),
  firstTask: z.string().trim().min(1).max(MAX_MESSAGE_CONTENT_LENGTH - 512),
})

export const AutomationSetupResultSchema = z.object({
  state: z.literal("sent"),
  server: z.object({ id: z.string(), handle: z.string(), url: z.url(), channel: z.string() }),
  bots: z.array(z.object({ id: z.string(), handle: z.string() })),
  message: z.object({ seq: z.string().regex(/^#[1-9]\d*$/) }),
})

export type AutomationSetupInput = z.infer<typeof AutomationSetupInputSchema>
export type AutomationSetupResult = z.infer<typeof AutomationSetupResultSchema>
