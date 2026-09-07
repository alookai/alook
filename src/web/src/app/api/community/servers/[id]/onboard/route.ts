import { NextRequest } from "next/server"
import { nanoid } from "nanoid"
import {
  AGENT_EVENT_PROMPT_MAX_LENGTH,
  CommunityServerOnboardRequestSchema,
  formatHandle,
  isUniqueConstraintError,
  makeRuntimeConfig,
  queries,
  resolveModelConfig,
  ROLES,
  WS_EVENTS,
} from "@alook/shared"
import type { CommunityMemberJoin } from "@alook/shared"

import { pushBotEventToMachine } from "@/lib/community/bot-push"
import {
  broadcastToUserSafe,
  fanOutToServerMembers,
} from "@/lib/community/fanout"
import { createCommunityMessage } from "@/lib/community/message-handler"
import { canonicalUserImage } from "@/lib/community/storage"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { parseBody, writeError, writeJSON } from "@/lib/middleware/helpers"

function joinHandles(handles: string[]) {
  if (handles.length <= 1) return handles[0] ?? ""
  if (handles.length === 2) return `${handles[0]} and ${handles[1]}`
  return `${handles.slice(0, -1).join(", ")}, and ${handles.at(-1)}`
}

export function onboardingGettingReadyMessage(teammateHandles: string[]) {
  const teammates = joinHandles(teammateHandles)
  return `We’re getting settled in Alook${teammates ? ` with ${teammates}` : ""}. Give us a few seconds, then come back—we’ll be ready to start.`
}

export function onboardingPromptWithSpace(
  prompt: string,
  serverHandle: string,
  channelName: string,
) {
  const serverRef = `/${serverHandle}`
  return [
    prompt,
    "",
    "## Your Alook space",
    "",
    `- Server: ${serverRef}`,
    `- Public channel: ${serverRef}/${channelName}`,
  ].join("\n")
}

export const POST = withAuth(async (req: NextRequest, ctx) => {
  const serverId = ctx.params?.id as string
  if (!serverId) return writeError("server id is required", 400)
  const [body, bodyError] = await parseBody(req, CommunityServerOnboardRequestSchema)
  if (bodyError) return bodyError

  const db = getDb(ctx.env.DB)
  const callerMember = await queries.communityMember.getMember(db, serverId, ctx.userId)
  if (!callerMember) return writeError("not a member of this server", 403)
  const server = await queries.communityServer.getServer(db, serverId)
  if (!server) return writeError("server not found", 404)

  const bots = []
  for (const requestedBot of body.bots) {
    const bot = await queries.communityBot.getBotOwnedBy(db, requestedBot.id, ctx.userId)
    if (!bot) return writeError("bot not found", 404)
    const wakeContext = await queries.communityBot.getBotWakeContext(db, requestedBot.id)
    if (wakeContext.state !== "ready") return writeError(wakeContext.state, 409)
    bots.push({ bot, wakeContext, wakePrompt: requestedBot.wakePrompt })
  }

  const publicChannel = (await queries.communityChannel.listServerChannels(db, serverId))
    .find((channel) => channel.name === "all" && channel.type === "text")
  if (!publicChannel) return writeError("the new server is missing its public channel", 409)

  const serverHandle = formatHandle(server.name, server.discriminator)
  const eventBots = bots.map((entry) => ({
    ...entry,
    eventPrompt: onboardingPromptWithSpace(entry.wakePrompt, serverHandle, publicChannel.name),
  }))
  if (eventBots.some(({ eventPrompt }) => eventPrompt.length > AGENT_EVENT_PROMPT_MAX_LENGTH)) {
    return writeError("wakePrompt is too long after adding the Alook space refs", 400)
  }
  const lead = eventBots.find(({ bot }) => bot.id === body.leadBotId)!

  for (const { bot } of eventBots) {
    let member = await queries.communityMember.getMember(db, serverId, bot.id)
    if (!member) {
      try {
        member = await queries.communityMember.addMember(db, {
          serverId,
          userId: bot.id,
          role: ROLES.MEMBER,
        })
      } catch (error) {
        if (!isUniqueConstraintError(error)) throw error
        member = await queries.communityMember.getMember(db, serverId, bot.id)
        if (!member) throw error
      }
      const joinEvent: CommunityMemberJoin = {
        type: WS_EVENTS.MEMBER_JOIN,
        serverId,
        member: {
          id: member.id,
          userId: bot.id,
          name: bot.name,
          discriminator: bot.discriminator,
          avatar: canonicalUserImage(bot.id, bot.image, bot.avatarVersion) ?? undefined,
          avatarVersion: bot.avatarVersion,
          role: member.role ?? ROLES.MEMBER,
          joinedAt: member.joinedAt,
        },
      }
      void fanOutToServerMembers(serverId, joinEvent)
    }
  }

  const teammateHandles = eventBots
    .filter(({ bot }) => bot.id !== lead.bot.id)
    .map(({ bot }) => `@${formatHandle(bot.name, bot.discriminator)}`)

  if (body.action.type === "wake") {
    const wakeBotId = body.action.botId
    const eventBot = eventBots.find(({ bot }) => bot.id === wakeBotId)!
    const { bot, wakeContext, eventPrompt } = eventBot
    const result = await pushBotEventToMachine(ctx.env, wakeContext.machineId, {
      type: "agent:event",
      agentId: bot.id,
      config: makeRuntimeConfig({
        runtime: wakeContext.runtime,
        model: resolveModelConfig(wakeContext.modelName),
        reasoningEffort: wakeContext.reasoningEffort ?? undefined,
        runtimeConfigRevision: wakeContext.runtimeConfigRevision,
        agentName: wakeContext.name,
        agentHandle: `@${formatHandle(wakeContext.name, wakeContext.discriminator)}`,
      }),
      launchId: nanoid(),
      prompt: eventPrompt,
      ...(bot.id === lead.bot.id ? { includeRecentContext: true } : {}),
    })
    if (result.sent === 0) {
      return writeError("machine is offline — bring its daemon online and retry", 409)
    }
    return writeJSON({ onboarded: 1, finalized: false })
  }

  const gettingReady = await createCommunityMessage({
    db,
    authorId: lead.bot.id,
    authorKind: "bot",
    target: { kind: "channel", channelId: publicChannel.id, serverId },
    body: { content: onboardingGettingReadyMessage(teammateHandles) },
    source: "web",
    deferBroadcast: true,
    clientNonce: `srv:onboarding-ready:${serverId}`,
  })
  if (!gettingReady.ok) return writeError(gettingReady.error, gettingReady.status)

  if (!gettingReady.deduped) await gettingReady.broadcast?.()

  const readerIds = [...new Set([ctx.userId, ...eventBots.map(({ bot }) => bot.id)])]
  const readStates = await Promise.all(readerIds.map(async (userId) => ({
    userId,
    result: await queries.communityReadState.markReadToMessageWithRevision(
      db,
      {
        userId,
        channelId: publicChannel.id,
        message: gettingReady.row,
      },
    ),
  })))

  const ownerReadState = readStates.find(({ userId }) => userId === ctx.userId)?.result
  if (ownerReadState?.changed) {
    await broadcastToUserSafe(ctx.userId, {
      type: WS_EVENTS.READ_STATE_ADVANCED,
      revision: ownerReadState.revision,
      inboxChanged: true,
    })
  }
  return writeJSON({ onboarded: 0, finalized: true })
})
