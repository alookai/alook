import { z } from "zod"
import { formatHandle, parseNameAndTag } from "./lib/discriminator"
import { MAX_MESSAGE_CONTENT_LENGTH, MAX_SERVER_DESCRIPTION_LENGTH, MAX_SERVER_NAME_LENGTH } from "./constants/community"

export const AUTOMATION_SETUP_PERMISSIONS = ["server.create", "server.invite", "message.send"] as const

const Handle = z.string().trim().max(128).refine(value => Boolean(parseNameAndTag(value)), "Use a full handle name#NNNN").transform(value => {
  const parsed = parseNameAndTag(value)!
  return formatHandle(parsed.name, parsed.discriminator)
})

export const AutomationSetupInputSchema = z.strictObject({
  server: z.strictObject({ name: z.string().trim().min(1).max(MAX_SERVER_NAME_LENGTH), description: z.string().max(MAX_SERVER_DESCRIPTION_LENGTH).optional() }),
  bots: z.array(Handle).min(1).max(3).refine(handles => new Set(handles).size === handles.length, "Choose each bot once"),
  firstTask: z.string().trim().min(1).max(MAX_MESSAGE_CONTENT_LENGTH - 512),
})

export const AutomationSetupResultSchema = z.strictObject({
  state: z.literal("sent"),
  server: z.strictObject({ handle: Handle, url: z.url(), channel: z.string() }),
  bots: z.array(Handle),
  message: z.strictObject({ seq: z.string().regex(/^#[1-9]\d*$/) }),
})

export type AutomationSetupInput = z.infer<typeof AutomationSetupInputSchema>
export type AutomationSetupResult = z.infer<typeof AutomationSetupResultSchema>
