import { z } from "zod"
import { resolveReasoningEffort } from "./community/bot-reasoning-effort"
import { requiresExplicitModel } from "./community/bot-model"
import type { CommunityMachineRuntime } from "./schemas"
import { CommunityBotCreateRequestSchema } from "./schemas"

export const BOT_CREATION_MAX_ITEMS = 20
export const BOT_CREATION_BODY_MAX_BYTES = 131072

export const BotCreationProposalSchema = z.strictObject({
  ...CommunityBotCreateRequestSchema.omit({ runtime: true, image: true }).shape,
  backendId: z.string().min(1).max(64),
  reason: z.string().trim().min(1).max(1000),
})

export const BotCreationSubmitSchema = z.strictObject({
  requestId: z.string().min(1).max(128),
  bots: z.array(BotCreationProposalSchema).min(1).max(BOT_CREATION_MAX_ITEMS),
})

export const BotCreationIdentitySchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  discriminator: z.string(),
  image: z.string().nullable(),
  avatarVersion: z.number().int().nonnegative(),
})

export const BotCreationItemSchema = BotCreationProposalSchema.extend({
  itemId: z.string(),
  description: z.string(),
  model: z.string().nullable(),
  reasoningEffort: z.string().nullable(),
  machineName: z.string(),
  createdBot: BotCreationIdentitySchema.nullable(),
})

export const BotCreationPayloadSchema = z.strictObject({
  requestId: z.string(),
  status: z.enum(["pending", "approved", "declined"]),
  requesterId: z.string(),
  ownerUserId: z.string(),
  createdAt: z.string(),
  resolvedAt: z.string().nullable(),
  bots: z.array(BotCreationItemSchema).min(1).max(BOT_CREATION_MAX_ITEMS),
})

export const BotCreationDecisionSchema = z.strictObject({ decision: z.enum(["approve", "decline"]) })
export type BotCreationProposal = z.infer<typeof BotCreationProposalSchema>
export type BotCreationSubmit = z.infer<typeof BotCreationSubmitSchema>
export type BotCreationItem = z.infer<typeof BotCreationItemSchema>
export type BotCreationPayload = z.infer<typeof BotCreationPayloadSchema>

export class BotCreationError extends Error {
  constructor(public code: string, message: string, public status = 400, public details: Record<string, unknown> = {}) { super(message) }
}

export function resolveBotCreationConfiguration(machine: { id: string; status: string }, runtime: CommunityMachineRuntime | undefined, bot: Pick<BotCreationProposal, "backendId" | "model" | "reasoningEffort">) {
  if (machine.status !== "online") throw new BotCreationError("MACHINE_OFFLINE", "Target machine is offline", 409, { machineId: machine.id })
  if (!runtime) throw new BotCreationError("BACKEND_NOT_FOUND", `runtime ${bot.backendId} not available on this machine`)
  if (runtime.status === "unhealthy") throw new BotCreationError("BACKEND_UNHEALTHY", `runtime ${bot.backendId} is currently unavailable on this machine — check the daemon logs`)
  if (requiresExplicitModel(bot.backendId) && !bot.model?.trim()) throw new BotCreationError("MODEL_REQUIRED", "Choose a model before saving")
  const effort = resolveReasoningEffort(runtime, bot.model ?? null, bot.reasoningEffort ?? null)
  if (!effort.supported) throw new BotCreationError("INVALID_REASONING_EFFORT", `reasoning effort ${bot.reasoningEffort} is not supported by this runtime/model`, 400, { allowedValues: effort.options.map((option) => option.value) })
  return effort
}
