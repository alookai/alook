import {
  createDb,
  queries,
  withD1Retry,
  WS_EVENTS,
} from "@alook/shared"
import type { UserConnectionState, WsDurableContext } from "./internal"
import { createInternalUserBroadcastRequest } from "../internal-user-broadcast"

export function handleClientTypingStart(
  context: WsDurableContext,
  state: UserConnectionState,
  parsed: unknown,
): boolean {
  const msg = parsed as { type: string }
  if (msg.type !== WS_EVENTS.TYPING_START) return false
  const typingMsg = parsed as {
    type: string
    channelId?: string
  }
  const scopeKey = typingMsg.channelId
  if (!scopeKey) return true

  const now = Date.now()
  let scopeMap = context.typingDedup.get(scopeKey)
  if (!scopeMap) {
    scopeMap = new Map()
    context.typingDedup.set(scopeKey, scopeMap)
  }
  const lastTs = scopeMap.get(state.userId) || 0
  if (now - lastTs < context.typingDedupMs) return true
  scopeMap.set(state.userId, now)

  if (context.typingDedup.size > 200) {
    for (const [key, map] of context.typingDedup) {
      let allStale = true
      for (const ts of map.values()) {
        if (now - ts < context.typingDedupMs * 4) {
          allStale = false
          break
        }
      }
      if (allStale) context.typingDedup.delete(key)
    }
  }

  const event = JSON.stringify({
    type: WS_EVENTS.TYPING_START,
    channelId: typingMsg.channelId,
    userId: state.userId,
    name: state.name,
    discriminator: state.discriminator,
  })

  fanOutTyping(context, state.userId, typingMsg.channelId, event).catch((err) => {
    context.log.warn("community:typing.start fan-out failed", { err: String(err) })
  })
  return true
}

export async function notifyUserDO(
  context: WsDurableContext,
  userId: string,
  payload: unknown,
): Promise<void> {
  try {
    const userDoId = context.env.WS_DO.idFromName("user:" + userId)
    const userStub = context.env.WS_DO.get(userDoId)
    try {
      await userStub.fetch(
        createInternalUserBroadcastRequest(userId, JSON.stringify(payload)),
      )
    } catch (err) {
      context.log.error("notifyUserDO: owner notify failed", { err: String(err), userId })
    }

    try {
      const status = machineStatusPayload(payload)
      if (!status) return
      const db = createDb(context.env.DB)
      const bots = await queries.communityBot.listBotsForMachine(db, status.machineId)
      if (bots.length === 0) return
      await Promise.allSettled(
        bots.map((bot) => broadcastPresence(context, bot.id, status.online))
      )
    } catch (err) {
      context.log.error("notifyUserDO: bot presence fan-out failed", { err: String(err), userId })
    }
  } catch (err) {
    context.log.error("notifyUserDO: unexpected failure", { err: String(err), userId })
  }
}

function machineStatusPayload(payload: unknown): { machineId: string; online: boolean } | null {
  if (typeof payload !== "object" || payload === null) return null
  const p = payload as { type?: unknown; machineId?: unknown; status?: unknown }
  if (p.type !== WS_EVENTS.MACHINE_STATUS) return null
  if (typeof p.machineId !== "string") return null
  if (p.status !== "online" && p.status !== "offline") return null
  return { machineId: p.machineId, online: p.status === "online" }
}

export async function fanOutTyping(
  context: WsDurableContext,
  senderUserId: string,
  channelId?: string,
  event?: string,
): Promise<void> {
  if (!event || !channelId) return
  const db = createDb(context.env.DB)
  let recipientUserIds: string[] = []

  const membership = await withD1Retry(
    () => queries.communityChannel.getChannelForMember(db, channelId, senderUserId),
    { route: "ws-do:agent-typing-membership" },
  )
  if (!membership) {
    context.log.warn("fanOutTyping: sender not a channel member", { senderUserId, channelId })
    return
  }
  recipientUserIds = await withD1Retry(
    () => queries.communityMembersResolver.resolveChannelRecipientUserIds(db, channelId),
    { route: "ws-do:agent-typing-recipients" },
  )
  recipientUserIds = recipientUserIds.filter((id) => id !== senderUserId)
  if (recipientUserIds.length === 0) return

  for (let i = 0; i < recipientUserIds.length; i += context.subrequestBatchSize) {
    const batch = recipientUserIds.slice(i, i + context.subrequestBatchSize)
    await Promise.all(
      batch.map((userId) => {
        const doId = context.env.WS_DO.idFromName("user:" + userId)
        const stub = context.env.WS_DO.get(doId)
        return stub.fetch(
          createInternalUserBroadcastRequest(userId, event),
        ).catch(() => { })
      })
    )
  }
}

export async function fanOutTypingStop(
  context: WsDurableContext,
  senderUserId: string,
  channelId: string,
): Promise<void> {
  const db = createDb(context.env.DB)
  const membership = await withD1Retry(
    () => queries.communityChannel.getChannelForMember(db, channelId, senderUserId),
    { route: "ws-do:agent-typing-stop-membership" },
  )
  if (!membership) {
    context.log.warn("fanOutTypingStop: sender not a channel member", { senderUserId, channelId })
    return
  }
  let recipientUserIds = await withD1Retry(
    () => queries.communityMembersResolver.resolveChannelRecipientUserIds(db, channelId),
    { route: "ws-do:agent-typing-stop-recipients" },
  )
  recipientUserIds = recipientUserIds.filter((id) => id !== senderUserId)
  if (recipientUserIds.length === 0) return
  const body = JSON.stringify({
    type: WS_EVENTS.TYPING_STOP,
    channelId,
    userId: senderUserId,
  })
  for (let i = 0; i < recipientUserIds.length; i += context.subrequestBatchSize) {
    const batch = recipientUserIds.slice(i, i + context.subrequestBatchSize)
    await Promise.all(
      batch.map((userId) => {
        const doId = context.env.WS_DO.idFromName("user:" + userId)
        const stub = context.env.WS_DO.get(doId)
        return stub.fetch(
          createInternalUserBroadcastRequest(userId, body),
        ).catch(() => { })
      })
    )
  }
}

export async function broadcastPresence(
  context: WsDurableContext,
  userId: string,
  online: boolean,
): Promise<void> {
  await broadcastToAudience(context, userId, { type: WS_EVENTS.PRESENCE_UPDATE, userId, online })
}

export async function broadcastToAudience(
  context: WsDurableContext,
  userId: string,
  payload: unknown,
): Promise<void> {
  const audience = await getPresenceAudience(context, userId)
  if (audience.length === 0) return
  const body = JSON.stringify(payload)
  for (let i = 0; i < audience.length; i += context.subrequestBatchSize) {
    const batch = audience.slice(i, i + context.subrequestBatchSize)
    await Promise.allSettled(
      batch.map((memberId) => {
        const doId = context.env.WS_DO.idFromName("user:" + memberId)
        const stub = context.env.WS_DO.get(doId)
        return stub.fetch(createInternalUserBroadcastRequest(memberId, body))
      })
    )
  }
}

async function getCoMembers(context: WsDurableContext, userId: string): Promise<string[]> {
  const db = createDb(context.env.DB)
  return queries.communityMember.getCoMemberUserIds(db, userId)
}

async function getFriendIds(context: WsDurableContext, userId: string): Promise<string[]> {
  const db = createDb(context.env.DB)
  return queries.communityFriendship.getFriendUserIds(db, userId)
}

export async function getPresenceAudience(
  context: WsDurableContext,
  userId: string,
): Promise<string[]> {
  const [coMembers, friends] = await Promise.all([
    getCoMembers(context, userId),
    getFriendIds(context, userId),
  ])
  return [...new Set([...coMembers, ...friends])]
}

export async function sendPresenceSnapshot(
  context: WsDurableContext,
  ws: WebSocket,
  userId: string,
): Promise<void> {
  const audience = await getPresenceAudience(context, userId)
  if (audience.length === 0) return
  const onlineIds: string[] = []
  for (let i = 0; i < audience.length; i += context.subrequestBatchSize) {
    const batch = audience.slice(i, i + context.subrequestBatchSize)
    const checks = await Promise.allSettled(
      batch.map(async (memberId) => {
        const doId = context.env.WS_DO.idFromName("user:" + memberId)
        const stub = context.env.WS_DO.get(doId)
        const resp = await stub.fetch(
          new Request(`http://internal/check-user-online?userId=${encodeURIComponent(memberId)}`)
        )
        const data = await resp.json() as { online: boolean; stale?: boolean }
        if (data.stale) return null
        return data.online ? memberId : null
      })
    )
    for (const r of checks) {
      if (r.status === "fulfilled" && r.value) onlineIds.push(r.value)
    }
  }
  for (const id of onlineIds) {
    ws.send(JSON.stringify({ type: WS_EVENTS.PRESENCE_UPDATE, userId: id, online: true }))
  }
}
