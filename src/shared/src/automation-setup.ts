import { z } from "zod"
import { MAX_MESSAGE_CONTENT_LENGTH, MAX_SERVER_DESCRIPTION_LENGTH, MAX_SERVER_NAME_LENGTH } from "./constants/community"

export const AUTOMATION_SETUP_PERMISSIONS = ["server.create", "server.invite", "message.send"] as const

export const AutomationSetupInputSchema = z.strictObject({
  server: z.strictObject({ name: z.string().trim().min(1).max(MAX_SERVER_NAME_LENGTH), description: z.string().max(MAX_SERVER_DESCRIPTION_LENGTH).optional() }),
  botIds: z.array(z.string().trim().min(1).max(128)).min(1).max(3).refine(ids => new Set(ids).size === ids.length, "Choose each bot once"),
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
