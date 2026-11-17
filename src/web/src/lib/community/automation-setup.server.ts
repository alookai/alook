import { NextRequest } from "next/server"
import { z } from "zod"
import { AutomationSetupInputSchema, AutomationSetupResultSchema, AutomationMessageSentSchema, formatHandle, queries, ROLES, WS_EVENTS } from "@alook/shared"
import type { AutomationSetupContext } from "@/lib/automation"
import { getPrimaryDb } from "@/lib/db"
import { parseBody, writeError, writeJSON } from "@/lib/middleware/helpers"
import { createServerForUser } from "./create-server.server"
import { sendAutomationMessage } from "./automation-message.server"
import { broadcastToUserSafe, fanOutToServerMembers, fanOutToUsers } from "./fanout"
import { canonicalUserImage } from "./storage"

const ServerReceipt = z.object({ server: z.object({ id: z.string(), name: z.string(), discriminator: z.string() }) })

export async function runAutomationSetup(req: NextRequest, ctx: AutomationSetupContext) {
  const [input, error] = await parseBody(req, AutomationSetupInputSchema)
  if (error) return error
  const db = getPrimaryDb(ctx.env.DB)
  let createdServerId: string | undefined
  const request = (body: unknown) => new NextRequest(req.url, { method: "POST", body: JSON.stringify(body) })
  const requireSuccess = async (response: Response) => {
    if (!response.ok) throw response
    return response.json()
  }
  try {
    const bots = []
    for (const id of input.botIds) {
      const bot = await queries.communityBot.getBotOwnedBy(db, id, ctx.userId)
      if (!bot) throw writeError("Owned bot not found", 404)
      bots.push(bot)
    }
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
    let remainingServerId: string | undefined
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
      } catch { remainingServerId = createdServerId }
    }
    let detail: Record<string, unknown> = { error: "Setup outcome is unknown; check the server and its bot membership before another attempt", code: "SETUP_OUTCOME_UNKNOWN" }
    if (failure instanceof Response) {
      try { detail = await failure.json() as Record<string, unknown> } catch { }
    }
    const response = writeJSON({ ...detail, cleanup: remainingServerId ? "incomplete" : failure instanceof Response ? "complete" : "unknown", ...(remainingServerId ? { remaining: { serverId: remainingServerId } } : {}),
      hint: remainingServerId ? "Inspect the remaining server before another setup attempt" : "If the command response was not received, check the server and its bot membership before running setup again" },
    failure instanceof Response ? failure.status : 503)
    if (failure instanceof Response && failure.headers.has("Retry-After")) response.headers.set("Retry-After", failure.headers.get("Retry-After")!)
    return response
  }
}
