import { NextRequest } from "next/server"
import { z } from "zod"
import { AutomationSetupInputSchema, AutomationSetupResultSchema, AutomationMessageSentSchema, formatHandle, queries, ROLES, WS_EVENTS } from "@alook/shared"
import type { AutomationSetupContext } from "@/lib/automation"
import { getPrimaryDb } from "@/lib/db"
import { parseBody, writeError, writeJSON } from "@/lib/middleware/helpers"
import { projectMachineBackends } from "./machine-options.server"
import { createBotForUser } from "./create-bot.server"
import { createServerForUser } from "./create-server.server"
import { sendAutomationMessage } from "./automation-message.server"
import { broadcastToUserSafe, fanOutToServerMembers, fanOutToUsers } from "./fanout"
import { pushBotEventToMachine } from "./bot-push"
import { canonicalUserImage } from "./storage"

const BotReceipt = z.object({ bot: z.object({ id: z.string(), name: z.string(), discriminator: z.string() }) })
const ServerReceipt = z.object({ server: z.object({ id: z.string(), name: z.string(), discriminator: z.string() }) })

export async function prepareAutomationSetup(_req: NextRequest, ctx: AutomationSetupContext) {
  const machines = await queries.automation.listMachines(getPrimaryDb(ctx.env.DB), ctx.userId)
  return writeJSON({ machines: machines.map(({ id, name, status, availableRuntimes }) => ({ id, name, status,
    backends: projectMachineBackends(queries.communityBot.normalizeMachineRuntimes(availableRuntimes), { includeCatalogMetadata: false }),
  })) })
}

export async function runAutomationSetup(req: NextRequest, ctx: AutomationSetupContext) {
  const [input, error] = await parseBody(req, AutomationSetupInputSchema)
  if (error) return error
  const db = getPrimaryDb(ctx.env.DB)
  const createdBotIds: string[] = []
  let createdServerId: string | undefined
  const bots: z.infer<typeof BotReceipt>["bot"][] = []
  const request = (body: unknown) => new NextRequest(req.url, { method: "POST", body: JSON.stringify(body) })
  const requireSuccess = async (response: Response) => {
    if (!response.ok) throw response
    return response.json()
  }
  try {
    for (const bot of input.bots) {
      if ("existingBotId" in bot) {
        const owned = await queries.communityBot.getBotOwnedBy(db, bot.existingBotId, ctx.userId)
        if (!owned) throw writeError("Owned bot not found", 404)
        bots.push(owned)
      } else {
        const { backendId, ...body } = bot
        const response = await createBotForUser(request({ ...body, runtime: backendId }), {
          ...ctx, beforeCreate: () => ctx.beforeAction("bot.create"), onCreated: id => { createdBotIds.push(id) },
        })
        bots.push(BotReceipt.parse(await requireSuccess(response)).bot)
      }
    }
    if (new Set(bots.map(bot => bot.id)).size !== bots.length) throw writeError("Choose each bot once", 400)
    const serverResponse = await createServerForUser(request(input.server), {
      ...ctx, beforeCreate: () => ctx.beforeAction("server.create"), onCreated: id => { createdServerId = id },
    })
    const { server } = ServerReceipt.parse(await requireSuccess(serverResponse))
    for (const bot of bots) {
      const denied = await ctx.beforeAction("server.invite")
      if (denied) throw denied
      const owned = await queries.communityBot.getBotOwnedBy(db, bot.id, ctx.userId)
      if (!owned) throw writeError("Owned bot not found", 404)
      const member = await queries.communityMember.addMember(db, { serverId: server.id, userId: bot.id })
      await fanOutToServerMembers(server.id, { type: WS_EVENTS.MEMBER_JOIN, serverId: server.id, member: {
        id: member.id, userId: bot.id, name: owned.name, discriminator: owned.discriminator,
        avatar: canonicalUserImage(bot.id, owned.image, owned.avatarVersion), avatarVersion: owned.avatarVersion,
        role: ROLES.MEMBER, joinedAt: member.joinedAt,
      } })
    }
    const serverHandle = formatHandle(server.name, server.discriminator), target = `/${serverHandle}/all`
    const message = await sendAutomationMessage(request({ target, as: "me",
      nonce: crypto.randomUUID(), content: `${bots.map(bot => `@${formatHandle(bot.name, bot.discriminator)}`).join(" ")}\n\n${input.firstTask}`,
    }), { ...ctx, beforeCreate: () => ctx.beforeAction("message.send") })
    const sent = AutomationMessageSentSchema.parse(await requireSuccess(message))
    return writeJSON(AutomationSetupResultSchema.parse({ state: "sent", server: { id: server.id, handle: serverHandle,
      channel: target, url: `${new URL(req.url).origin}/c/channels/${encodeURIComponent(server.id)}` },
    bots: bots.map(bot => ({ id: bot.id, handle: formatHandle(bot.name, bot.discriminator) })), message: { seq: sent.seq } }))
  } catch (failure) {
    const remaining: { serverId?: string; botIds: string[] } = { botIds: [] }
    if (createdServerId) {
      try {
        const recipients = await queries.communityMember.listMemberUserIds(db, createdServerId)
        const deleted = await queries.communityDeleteMedia.deleteServerWithMedia(db, { serverId: createdServerId, ownerId: ctx.userId })
        await Promise.allSettled([
          fanOutToUsers(recipients, { type: WS_EVENTS.SERVER_DELETE, serverId: createdServerId }),
          ...deleted.readStateRevisions.map(revision => broadcastToUserSafe(revision.userId, {
            type: WS_EVENTS.READ_STATE_ADVANCED, revision: revision.revision, inboxChanged: true,
          })),
        ])
      } catch { remaining.serverId = createdServerId }
    }
    for (const id of createdBotIds) {
      try {
        const bot = await queries.communityBot.getBotOwnedBy(db, id, ctx.userId)
        await queries.communityBot.softDeleteBot(db, id, ctx.userId)
        if (bot?.machineId) await pushBotEventToMachine(ctx.env, bot.machineId, { type: "bot:removed", botId: id })
      } catch { remaining.botIds.push(id) }
    }
    const cleanupFailed = Boolean(remaining.serverId || remaining.botIds.length)
    let detail: Record<string, unknown> = { error: "Setup outcome is unknown; check whether the server and bots were created before another attempt", code: "SETUP_OUTCOME_UNKNOWN" }
    if (failure instanceof Response) {
      try { detail = await failure.json() as Record<string, unknown> } catch { }
    }
    const response = writeJSON({ ...detail, cleanup: cleanupFailed ? "incomplete" : failure instanceof Response ? "complete" : "unknown", ...(cleanupFailed ? { remaining } : {}),
      hint: cleanupFailed ? "Inspect the remaining resources before another setup attempt" : "If the command response was not received, check the server and bots before running setup again" },
    failure instanceof Response ? failure.status : 503)
    if (failure instanceof Response && failure.headers.has("Retry-After")) response.headers.set("Retry-After", failure.headers.get("Retry-After")!)
    return response
  }
}
