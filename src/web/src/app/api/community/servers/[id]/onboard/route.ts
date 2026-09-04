import { NextRequest } from "next/server"
import { nanoid } from "nanoid"
import {
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
import { fanOutToServerMembers } from "@/lib/community/fanout"
import { canonicalUserImage } from "@/lib/community/storage"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { parseBody, writeError, writeJSON } from "@/lib/middleware/helpers"

export const POST = withAuth(async (req: NextRequest, ctx) => {
  const serverId = ctx.params?.id as string
  if (!serverId) return writeError("server id is required", 400)
  const [body, bodyError] = await parseBody(req, CommunityServerOnboardRequestSchema)
  if (bodyError) return bodyError

  const db = getDb(ctx.env.DB)
  const callerMember = await queries.communityMember.getMember(db, serverId, ctx.userId)
  if (!callerMember) return writeError("not a member of this server", 403)

  const bots = []
  for (const botId of body.botIds) {
    const bot = await queries.communityBot.getBotOwnedBy(db, botId, ctx.userId)
    if (!bot) return writeError("bot not found", 404)
    const wakeContext = await queries.communityBot.getBotWakeContext(db, botId)
    if (wakeContext.state !== "ready") return writeError(wakeContext.state, 409)
    bots.push({ bot, wakeContext })
  }

  for (const { bot } of bots) {
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

  for (const { bot, wakeContext } of bots) {
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
      prompt: body.wakePrompt,
    })
    if (result.sent === 0) {
      return writeError("machine is offline — bring its daemon online and retry", 409)
    }
  }

  return writeJSON({ onboarded: body.botIds.length })
})
