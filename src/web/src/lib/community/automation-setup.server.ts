import { NextRequest } from "next/server"
import { z } from "zod"
import { AutomationSetupInputSchema, AutomationSetupResultSchema, AutomationMessageSentSchema, formatHandle, queries, ROLES, WS_EVENTS } from "@alook/shared"
import type { AutomationSetupContext } from "@/lib/automation"
import { getPrimaryDb } from "@/lib/db"
import { parseBody, writeError, writeJSON } from "@/lib/middleware/helpers"
import { createServerForUser } from "./create-server.server"
import { sendAutomationMessage } from "./automation-message.server"
import { broadcastDeliveriesSafe, fanOutToServerMembers, fanOutToUsers } from "./fanout"
import { canonicalUserImage } from "./storage"

const ServerReceipt = z.object({ server: z.object({ id: z.string(), name: z.string(), discriminator: z.string() }) })

export async function runAutomationSetup(req: NextRequest, ctx: AutomationSetupContext) {
  const [input, error] = await parseBody(req, AutomationSetupInputSchema)
  if (error) return error
  const db = getPrimaryDb(ctx.env.DB)
  let createdServer: { id: string; handle: string } | undefined
  const request = (body: unknown) => new NextRequest(req.url, { method: "POST", body: JSON.stringify(body) })
  const requireSuccess = async (response: Response) => {
    if (!response.ok) throw response
    return response.json()
  }
  try {
    const bots = []
    for (const handle of input.bots) {
      const bot = await queries.automation.getOwnedBotByHandle(db, ctx.userId, handle)
      if (!bot) throw writeError("Owned bot not found", 404)
      bots.push({ id: bot.id, handle })
    }
    const serverResponse = await createServerForUser(request(input.server), {
      ...ctx, beforeCreate: () => ctx.beforeAction("server.create"), onCreated: server => { createdServer = { id: server.id, handle: formatHandle(server.name, server.discriminator) } },
    })
    const { server } = ServerReceipt.parse(await requireSuccess(serverResponse))
    for (const bot of bots) {
      const denied = await ctx.beforeAction("server.invite")
      if (denied) throw denied
      const owned = await queries.communityBot.getBotOwnedBy(db, bot.id, ctx.userId)
      if (!owned) throw writeError("Owned bot not found", 404)
      bot.handle = formatHandle(owned.name, owned.discriminator)
      const member = await queries.communityMember.addMember(db, { serverId: server.id, userId: bot.id })
      const botOnline = await queries.communityMachine.isBotOnline(db, bot.id)
      await fanOutToServerMembers(server.id, { type: WS_EVENTS.MEMBER_JOIN, serverId: server.id, online: botOnline, member: {
        id: member.id, userId: bot.id, name: owned.name, discriminator: owned.discriminator,
        avatar: canonicalUserImage(bot.id, owned.image, owned.avatarVersion), avatarVersion: owned.avatarVersion,
        role: ROLES.MEMBER, joinedAt: member.joinedAt,
      } })
    }
    const serverHandle = formatHandle(server.name, server.discriminator), target = `/${serverHandle}/all`
    const message = await sendAutomationMessage(request({ target, as: "me",
      nonce: crypto.randomUUID(), content: `${bots.map(bot => `@${bot.handle}`).join(" ")}\n\n${input.firstTask}`,
    }), { ...ctx, beforeCreate: () => ctx.beforeAction("message.send") })
    const sent = AutomationMessageSentSchema.parse(await requireSuccess(message))
    return writeJSON(AutomationSetupResultSchema.parse({ state: "sent", server: { handle: serverHandle,
      channel: target, url: `${new URL(req.url).origin}/c/channels/${encodeURIComponent(server.id)}` },
    bots: bots.map(bot => bot.handle), message: { seq: sent.seq } }))
  } catch (failure) {
    let remainingServer: string | undefined
    if (createdServer) {
      try {
        const recipients = await queries.communityMember.listMemberUserIds(db, createdServer.id)
        const deleted = await queries.communityDeleteMedia.deleteServerWithMedia(db, { serverId: createdServer.id, ownerId: ctx.userId })
        await Promise.allSettled([
          fanOutToUsers(recipients, { type: WS_EVENTS.SERVER_DELETE, serverId: createdServer.id }),
          broadcastDeliveriesSafe(deleted.readStateRevisions.map(revision => ({
            userId: revision.userId,
            event: {
              type: WS_EVENTS.READ_STATE_ADVANCED, revision: revision.revision, inboxChanged: true,
            },
          }))),
        ])
      } catch { remainingServer = createdServer.handle }
    }
    let detail: Record<string, unknown> = { error: "Setup outcome is unknown; check the server and its bot membership before another attempt", code: "SETUP_OUTCOME_UNKNOWN" }
    if (failure instanceof Response) {
      try { detail = await failure.json() as Record<string, unknown> } catch { }
    }
    const response = writeJSON({ ...detail, cleanup: remainingServer ? "incomplete" : failure instanceof Response ? "complete" : "unknown", ...(remainingServer ? { remaining: { server: remainingServer } } : {}),
      hint: remainingServer ? "Inspect the remaining server before another setup attempt" : "If the command response was not received, check the server and its bot membership before running setup again" },
    failure instanceof Response ? failure.status : 503)
    if (failure instanceof Response && failure.headers.has("Retry-After")) response.headers.set("Retry-After", failure.headers.get("Retry-After")!)
    return response
  }
}
