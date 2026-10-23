import { and, eq, exists, inArray, isNull, or } from "drizzle-orm"
import { nanoid } from "nanoid"
import type { Database } from "../../index"
import { communityBotCreationRequest as requests } from "../../bot-creation-schema"
import { communityMachine } from "../../community-machine-schema"
import { user } from "../../schema"
import { BotCreationError, resolveBotCreationConfiguration, BotCreationPayloadSchema, type BotCreationItem, type BotCreationPayload, type BotCreationProposal, type BotCreationSubmit } from "../../../community-bot-creation"
import { buildBotCreationStatements, getMachineForOwner, isBotEntitlementLimitError } from "./bot"
import { getBotCapacitySummary } from "../product-plan"
import { createOrGetDM } from "./dm"
import { createMessage } from "./message"
import { computeDiscriminator } from "../../../lib/discriminator"
import { withUniqueDiscriminator } from "../user"
import { jsonTextSet } from "../_json-set"

export { BotCreationError } from "../../../community-bot-creation"

export async function validateBotConfigurations(db: Database, ownerId: string, bots: readonly Pick<BotCreationProposal, "machineId" | "backendId" | "model" | "reasoningEffort">[]) {
  const machines = new Map<string, Awaited<ReturnType<typeof getMachineForOwner>>>()
  const resolved = []
  for (const [index, bot] of bots.entries()) {
    const details = { itemIndex: index + 1 }
    if (!machines.has(bot.machineId)) machines.set(bot.machineId, await getMachineForOwner(db, bot.machineId, ownerId))
    const machine = machines.get(bot.machineId)
    if (!machine) throw new BotCreationError("MACHINE_NOT_FOUND", "machine not found", 404, details)
    const runtime = machine.availableRuntimes.find((candidate) => candidate.id === bot.backendId)
    let effort
    try { effort = resolveBotCreationConfiguration(machine, runtime, bot) }
    catch (error) {
      if (error instanceof BotCreationError) error.details = { ...error.details, ...details }
      throw error
    }
    resolved.push({ machine, reasoningEffort: effort.canonicalEffort })
  }
  return resolved
}

async function assertCapacity(db: Database, ownerId: string, required: number) {
  const capacity = await getBotCapacitySummary(db, ownerId)
  const available = Math.max(0, capacity.limit - capacity.ownedCount)
  if (available < required) throw new BotCreationError("BOT_LIMIT_REACHED", "Not enough bot slots for this request", 409, { required, available, plan: capacity.plan.id, limit: capacity.limit, ownedCount: capacity.ownedCount, activeCount: capacity.activeCount })
}

async function assertRequester(db: Database, ownerId: string, requesterId: string) {
  const rows = await db.select({ id: user.id }).from(user).where(and(eq(user.id, requesterId), eq(user.ownerUserId, ownerId), eq(user.isBot, true), isNull(user.deletedAt)))
  const owners = await db.select({ id: user.id }).from(user).where(and(eq(user.id, ownerId), eq(user.isBot, false), isNull(user.deletedAt)))
  if (!rows.length || !owners.length) throw new BotCreationError("REQUESTER_UNAVAILABLE", "Requesting bot or owner is unavailable", 409)
}

export function projectCreationRequest(row: typeof requests.$inferSelect): BotCreationPayload {
  return BotCreationPayloadSchema.parse({ requestId: row.id, status: row.status, requesterId: row.requesterId, ownerUserId: row.ownerId,
    createdAt: row.createdAt, resolvedAt: row.resolvedAt, bots: row.bots })
}

export async function getCreationRequest(db: Database, requestId: string, scope: { ownerId: string } | { requesterId: string }) {
  const rows = await db.select().from(requests).where(and(eq(requests.id, requestId), "ownerId" in scope ? eq(requests.ownerId, scope.ownerId) : eq(requests.requesterId, scope.requesterId))).limit(1)
  return rows[0] ?? null
}


export async function submitCreationRequest(db: Database, ownerId: string, requesterId: string, input: BotCreationSubmit) {
  const existing = await getCreationRequest(db, input.requestId, { requesterId })
  if (existing) return { row: existing, isNew: false }
  await assertRequester(db, ownerId, requesterId)
  await assertCapacity(db, ownerId, input.bots.length)
  const configured = await validateBotConfigurations(db, ownerId, input.bots)
  const bots: BotCreationItem[] = input.bots.map((bot, index) => ({ ...bot, itemId: nanoid(), description: bot.description ?? "", model: bot.model ?? null,
    reasoningEffort: configured[index]!.reasoningEffort, machineName: configured[index]!.machine.displayName,
    createdBot: null }))
  const dm = await createOrGetDM(db, { userId1: ownerId, userId2: requesterId })
  const messageId = nanoid()
  const row: typeof requests.$inferInsert = { id: input.requestId, requesterId, ownerId, channelId: dm.id, messageId, status: "pending", bots, createdAt: new Date().toISOString(), resolvedAt: null, decisionNonce: null }
  try {
    await createMessage(db, { id: messageId, authorId: requesterId, channelId: dm.id, content: `Request to create ${bots.length} bot${bots.length === 1 ? "" : "s"}`, type: "bot_creation_request", clientNonce: `bot-creation:${input.requestId}`, extraStatements: [db.insert(requests).values(row)] })
  } catch (error) {
    const winner = await getCreationRequest(db, input.requestId, { requesterId })
    if (winner) return { row: winner, isNew: false }
    throw error
  }
  return { row: (await getCreationRequest(db, input.requestId, { requesterId }))!, isNew: true }
}

export async function decideCreationRequest(db: Database, ownerId: string, requestId: string, decision: "approve" | "decline") {
  const row = await getCreationRequest(db, requestId, { ownerId })
  if (!row) throw new BotCreationError("REQUEST_NOT_FOUND", "Creation request not found", 404)
  if (row.status !== "pending") return { row, changed: false }
  const pending = and(eq(requests.id, requestId), eq(requests.ownerId, ownerId), eq(requests.status, "pending"))
  const now = new Date().toISOString()
  if (decision === "decline") {
    const changed = await db.update(requests).set({ status: "declined", resolvedAt: now }).where(pending).returning({ id: requests.id })
    return { row: (await getCreationRequest(db, requestId, { ownerId }))!, changed: changed.length > 0 }
  }
  await assertRequester(db, ownerId, row.requesterId)
  await assertCapacity(db, ownerId, row.bots.length)
  const configured = await validateBotConfigurations(db, ownerId, row.bots)
  const decisionNonce = nanoid()
  const ids = row.bots.map((item) => item.itemId)
  const initialSalt = computeDiscriminator(requestId)
  try {
    return await withUniqueDiscriminator(db, { id: requestId, name: "bot creation request" }, async (salt) => {
      const bots: BotCreationItem[] = row.bots.map((item, index) => ({ ...item, reasoningEffort: configured[index]!.reasoningEffort,
        machineName: configured[index]!.machine.displayName,
        createdBot: { id: ids[index]!, name: item.name, discriminator: salt === initialSalt ? computeDiscriminator(ids[index]!) : computeDiscriminator(`${ids[index]}:${salt}`, salt.length), image: null, avatarVersion: 0 } }))
      const validOwner = exists(db.select({ id: user.id }).from(user).where(and(eq(user.id, ownerId), eq(user.isBot, false), isNull(user.deletedAt))))
      const validRequester = exists(db.select({ id: user.id }).from(user).where(and(eq(user.id, row.requesterId), eq(user.ownerUserId, ownerId), eq(user.isBot, true), isNull(user.deletedAt))))
      const claim = db.update(requests).set({ status: "approved", bots, resolvedAt: now, decisionNonce }).where(and(pending, validOwner, validRequester)).returning({ id: requests.id })
      const claimed = exists(db.select({ id: requests.id }).from(requests).where(and(eq(requests.id, requestId), eq(requests.ownerId, ownerId), eq(requests.status, "approved"), eq(requests.decisionNonce, decisionNonce))))
      const statements = bots.flatMap((item) => {
        const ownedMachine = exists(db.select({ id: communityMachine.id }).from(communityMachine).where(and(eq(communityMachine.id, item.machineId), eq(communityMachine.userId, ownerId), eq(communityMachine.status, "online"))))
        return buildBotCreationStatements(db, { ownerId, name: item.name, description: item.description, machineId: item.machineId, runtime: item.backendId, modelName: item.model, reasoningEffort: item.reasoningEffort }, { botId: item.createdBot!.id, discriminator: item.createdBot!.discriminator, nowIso: now }, and(claimed, ownedMachine))
      })
      const results = await db.batch([claim, ...statements] as never)
      return { row: (await getCreationRequest(db, requestId, { ownerId }))!, changed: (results[0] as Array<{ id: string }>).length > 0 }
    })
  } catch (error) {
    const winner = await getCreationRequest(db, requestId, { ownerId })
    if (winner?.status !== "pending" && winner) return { row: winner, changed: false }
    if (isBotEntitlementLimitError(error)) await assertCapacity(db, ownerId, row.bots.length)
    await validateBotConfigurations(db, ownerId, row.bots)
    throw error
  }
}

export async function hydrateCreationRequestsForDmMessages(db: Database, messageIds: string[], viewerId: string) {
  if (!messageIds.length) return new Map<string, BotCreationPayload>()
  const rows = await db.select().from(requests).where(and(inArray(requests.messageId, jsonTextSet(db, messageIds)), or(eq(requests.ownerId, viewerId), eq(requests.requesterId, viewerId))))
  return new Map(rows.map((row) => [row.messageId, projectCreationRequest(row)]))
}
