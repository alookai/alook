import {
  COMMUNITY_FOCUS_SET_EVENT,
  createDb,
  queries,
  withD1Retry,
  WS_EVENTS,
  encodeCommunityBrowserEvent,
  validateCommunityWsEvent,
  isCommunityEventCandidate,
  visibilityIsDmParticipant,
  type Database,
} from "@alook/shared"
import type { ConnectionState, UserConnectionState, WsDurableContext } from "./internal"
import { createInternalBrowserBroadcastRequest } from "../internal-user-broadcast"
import { logCommunityBrowserEventRejected } from "../community-browser-event-ingress"
import { settleInBatches } from "../settle-in-batches"
import {
  channelRoomDoName,
  checkHumansOnlineWithRelay,
  fanOutToRecipientsWithRelay,
  serverRoomDoName,
} from "./scope-room"

const MAX_FOCUSED_CHANNELS_PER_SOCKET = 4
const BOT_PRESENCE_D1_CHUNK_SIZE = 1000
const FOCUS_RENEW_INTERVAL_MS = 10 * 60 * 1000

function normalizeBrowserPayload(
  context: WsDurableContext,
  payload: unknown,
): { ok: true; payload: unknown } | { ok: false } {
  if (!isCommunityEventCandidate(payload)) return { ok: true, payload }
  const normalized = validateCommunityWsEvent(payload)
  if (!normalized.ok) {
    logCommunityBrowserEventRejected(context.log, "ws-do-producer", normalized)
    return { ok: false }
  }
  return { ok: true, payload: normalized.event }
}

function createPrimaryDb(d1: D1Database): Database {
  const session = d1.withSession("first-primary")
  return createDb(session as unknown as Parameters<typeof createDb>[0])
}

async function canCommunicateInTypingScope(
  db: Database,
  channelType: string,
  channelId: string,
  senderUserId: string,
): Promise<{ ok: true; dmPeerUserId?: string } | { ok: false }> {
  if (!visibilityIsDmParticipant(channelType)) return { ok: true }
  const peer = await queries.communityDm.getDMPeer(db, channelId, senderUserId)
  if (!peer) return { ok: false }
  const blocked = await queries.communityFriendship.isBlocked(
    db,
    senderUserId,
    peer.otherUserId,
  )
  if (blocked) return { ok: false }
  const friends = await queries.communityFriendship.areFriends(db, senderUserId, peer.otherUserId)
  return friends ? { ok: true, dmPeerUserId: peer.otherUserId } : { ok: false }
}

async function serializeTypingFanOut(
  context: WsDurableContext,
  userId: string,
  channelId: string,
  type: "start" | "stop",
  operation: () => Promise<void>,
): Promise<void> {
  const key = `${channelId}\u0000${userId}`
  const previous = context.typingFanoutChains.get(key) ?? Promise.resolve()
  const delivery = previous.then(operation).catch((err) => {
    context.log.warn(`community:typing.${type} fan-out failed`, { err: String(err) })
  })
  context.typingFanoutChains.set(key, delivery)
  try {
    await delivery
  } finally {
    if (context.typingFanoutChains.get(key) === delivery) context.typingFanoutChains.delete(key)
  }
}

export function handleClientTypingStart(
  context: WsDurableContext,
  state: UserConnectionState,
  parsed: unknown,
): false | Promise<void> {
  const msg = parsed as { type: string }
  if (msg.type !== WS_EVENTS.TYPING_START) return false
  const typingMsg = parsed as {
    type: string
    channelId?: string
  }
  const scopeKey = typingMsg.channelId
  if (!scopeKey) return Promise.resolve()

  const now = Date.now()
  let scopeMap = context.typingDedup.get(scopeKey)
  if (!scopeMap) {
    scopeMap = new Map()
    context.typingDedup.set(scopeKey, scopeMap)
  }
  const lastTs = scopeMap.get(state.userId) || 0
  if (now - lastTs < context.typingDedupMs) return Promise.resolve()
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

  const event = {
    type: WS_EVENTS.TYPING_START,
    channelId: typingMsg.channelId,
    userId: state.userId,
    name: state.name,
    discriminator: state.discriminator,
  }

  return serializeTypingFanOut(context, state.userId, scopeKey, "start", () => (
    fanOutTyping(context, state.userId, scopeKey, event)
  ))
}

export function handleClientTypingStop(
  context: WsDurableContext,
  state: UserConnectionState,
  parsed: unknown,
): false | Promise<void> {
  const msg = parsed as { type: string; channelId?: string }
  if (msg.type !== WS_EVENTS.TYPING_STOP) return false
  const scopeKey = msg.channelId
  if (!scopeKey) return Promise.resolve()

  const scopeMap = context.typingDedup.get(scopeKey)
  scopeMap?.delete(state.userId)
  if (scopeMap?.size === 0) context.typingDedup.delete(scopeKey)

  return serializeTypingFanOut(context, state.userId, scopeKey, "stop", () => (
    fanOutTypingStop(context, state.userId, scopeKey)
  ))
}

function sendPresenceSnapshotFrame(ws: WebSocket, onlineUserIds: readonly string[]): void {
  const uniqueIds = [...new Set(onlineUserIds)]
  if (uniqueIds.length === 0) return
  const encoded = encodeCommunityBrowserEvent({
    type: WS_EVENTS.PRESENCE_SNAPSHOT,
    onlineUserIds: uniqueIds,
  })
  if (encoded.ok) ws.send(encoded.body)
}

async function postRoomFocus(
  context: WsDurableContext,
  roomName: string,
  userId: string,
  active: boolean,
  includeSnapshot = false,
): Promise<string[]> {
  try {
    const doId = context.env.WS_DO.idFromName(roomName)
    const stub = context.env.WS_DO.get(doId)
    const resp = await stub.fetch(new Request("http://internal/room/focus", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, active, includeSnapshot }),
    }))
    if (!resp.ok || !includeSnapshot) return []
    const data = await resp.json() as { onlineUserIds?: unknown }
    return Array.isArray(data.onlineUserIds)
      ? data.onlineUserIds.filter((id): id is string => typeof id === "string")
      : []
  } catch {
    return []
  }
}

function otherSocketStillFocusesServer(
  context: WsDurableContext,
  excludingWs: WebSocket,
  userId: string,
  serverId: string,
): boolean {
  return context.ctx.getWebSockets().some((ws) => {
    if (ws === excludingWs) return false
    const attachment = ws.deserializeAttachment() as ConnectionState
    return attachment?.type === "user"
      && attachment.authenticated
      && attachment.userId === userId
      && attachment.focusedServerId === serverId
  })
}

function otherSocketStillFocusesChannel(
  context: WsDurableContext,
  excludingWs: WebSocket,
  userId: string,
  channelId: string,
): boolean {
  return context.ctx.getWebSockets().some((ws) => {
    if (ws === excludingWs) return false
    const attachment = ws.deserializeAttachment() as ConnectionState
    return attachment?.type === "user"
      && attachment.authenticated
      && attachment.userId === userId
      && Boolean(attachment.focusedChannelIds?.includes(channelId))
  })
}

export function handleClientFocusSet(
  context: WsDurableContext,
  ws: WebSocket,
  state: UserConnectionState,
  parsed: unknown,
): false | Promise<void> {
  const msg = parsed as { type?: unknown; serverId?: unknown; channelIds?: unknown }
  if (msg.type !== COMMUNITY_FOCUS_SET_EVENT) return false

  return (async () => {
    const db = createDb(context.env.DB)
    const requestedServerId = typeof msg.serverId === "string" && msg.serverId.length > 0 ? msg.serverId : null
    const rawChannelIds = Array.isArray(msg.channelIds)
      ? [...new Set(msg.channelIds.filter((id): id is string => typeof id === "string" && id.length > 0))].slice(0, MAX_FOCUSED_CHANNELS_PER_SOCKET)
      : []

    let authorizedServerId: string | null = null
    if (requestedServerId) {
      const member = await withD1Retry(
        () => queries.communityMember.getMember(db, requestedServerId, state.userId),
        { route: "ws-do:focus-server-member" },
      )
      if (member) authorizedServerId = requestedServerId
    }

    let authorizedChannelIds: string[] = []
    if (rawChannelIds.length > 0) {
      const now = Date.now()
      const missing: string[] = []
      const allowed = new Set<string>()
      for (const id of rawChannelIds) {
        if (context.channelAccessCache.getReadable(state.userId, id, now)) {
          allowed.add(id)
        } else {
          missing.push(id)
        }
      }
      if (missing.length > 0) {
        const rows = await withD1Retry(
          () => queries.communityChannel.listReadableChannelsForUser(db, state.userId, missing),
          { route: "ws-do:focus-channel-access" },
        )
        context.channelAccessCache.setReadable(state.userId, rows, now)
        for (const row of rows) allowed.add(row.id)
      }
      authorizedChannelIds = rawChannelIds.filter((id) => allowed.has(id))
    }

    const current = ws.deserializeAttachment() as ConnectionState
    if (current?.type !== "user" || !current.authenticated || current.userId !== state.userId) return

    const previousServerId = current.focusedServerId ?? null
    const previousChannelIds = new Set(current.focusedChannelIds ?? [])
    const nextChannelSet = new Set(authorizedChannelIds)

    ws.serializeAttachment({
      ...current,
      focusedServerId: authorizedServerId,
      focusedChannelIds: authorizedChannelIds,
      focusRenewedAt: Date.now(),
    } as ConnectionState)

    const operations: Promise<unknown>[] = []
    if (previousServerId && previousServerId !== authorizedServerId && !otherSocketStillFocusesServer(context, ws, state.userId, previousServerId)) {
      operations.push(postRoomFocus(context, serverRoomDoName(previousServerId), state.userId, false))
    }
    for (const prevChannelId of previousChannelIds) {
      if (!nextChannelSet.has(prevChannelId) && !otherSocketStillFocusesChannel(context, ws, state.userId, prevChannelId)) {
        operations.push(postRoomFocus(context, channelRoomDoName(prevChannelId), state.userId, false))
      }
    }

    let serverOnlineIds: string[] = []
    if (authorizedServerId && authorizedServerId !== previousServerId) {
      operations.push(
        postRoomFocus(context, serverRoomDoName(authorizedServerId), state.userId, true, true)
          .then((ids) => { serverOnlineIds = ids }),
      )
    }
    for (const nextChannelId of authorizedChannelIds) {
      if (!previousChannelIds.has(nextChannelId)) {
        operations.push(postRoomFocus(context, channelRoomDoName(nextChannelId), state.userId, true))
      }
    }

    await Promise.allSettled(operations)
    if (serverOnlineIds.length > 0) {
      sendPresenceSnapshotFrame(ws, serverOnlineIds)
    }
  })()
}

export async function renewSocketRoomsIfDue(
  context: WsDurableContext,
  ws: WebSocket,
  state: UserConnectionState,
): Promise<void> {
  const now = Date.now()
  if (state.focusRenewedAt !== undefined && now - state.focusRenewedAt < FOCUS_RENEW_INTERVAL_MS) {
    return
  }
  const current = ws.deserializeAttachment() as ConnectionState
  if (current?.type !== "user" || !current.authenticated || current.userId !== state.userId) return
  if (current.focusRenewedAt !== undefined && now - current.focusRenewedAt < FOCUS_RENEW_INTERVAL_MS) {
    return
  }
  ws.serializeAttachment({ ...current, focusRenewedAt: now } as ConnectionState)

  const focusOperations: Promise<unknown>[] = []
  if (current.focusedServerId) {
    focusOperations.push(postRoomFocus(context, serverRoomDoName(current.focusedServerId), current.userId, true, false))
  }
  for (const channelId of current.focusedChannelIds ?? []) {
    focusOperations.push(postRoomFocus(context, channelRoomDoName(channelId), current.userId, true, false))
  }

  let serverIds: string[] = []
  try {
    serverIds = await queries.communityMember.listServerIdsForUser(createDb(context.env.DB), current.userId)
  } catch { }

  await Promise.allSettled([
    ...focusOperations,
    settleInBatches(serverIds, async (serverId) => {
      const roomDoId = context.env.WS_DO.idFromName(serverRoomDoName(serverId))
      const roomStub = context.env.WS_DO.get(roomDoId)
      await roomStub.fetch(new Request("http://internal/room/presence-renew", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: current.userId }),
      }))
    }, context.subrequestBatchSize),
  ])
}

export async function unregisterSocketFocus(
  context: WsDurableContext,
  ws: WebSocket,
  state: UserConnectionState,
): Promise<void> {
  const operations: Promise<unknown>[] = []
  if (state.focusedServerId && !otherSocketStillFocusesServer(context, ws, state.userId, state.focusedServerId)) {
    operations.push(postRoomFocus(context, serverRoomDoName(state.focusedServerId), state.userId, false))
  }
  for (const channelId of state.focusedChannelIds ?? []) {
    if (!otherSocketStillFocusesChannel(context, ws, state.userId, channelId)) {
      operations.push(postRoomFocus(context, channelRoomDoName(channelId), state.userId, false))
    }
  }
  if (operations.length > 0) {
    await Promise.allSettled(operations)
  }
}

export async function notifyUserDO(
  context: WsDurableContext,
  userId: string,
  payload: unknown,
): Promise<void> {
  const normalized = normalizeBrowserPayload(context, payload)
  if (!normalized.ok) return
  try {
    const userDoId = context.env.WS_DO.idFromName("user:" + userId)
    const userStub = context.env.WS_DO.get(userDoId)
    await userStub.fetch(createInternalBrowserBroadcastRequest(userId, normalized.payload))
  } catch (err) {
    context.log.error("notifyUserDO: owner notify failed", { err: String(err), userId })
  }
}

export async function fanOutTyping(
  context: WsDurableContext,
  senderUserId: string,
  channelId?: string,
  event?: unknown,
): Promise<void> {
  if (!event || !channelId) return
  const normalized = normalizeBrowserPayload(context, event)
  if (!normalized.ok) return
  const outboundEvent = normalized.payload
  const db = createPrimaryDb(context.env.DB)

  const membership = await withD1Retry(
    () => queries.communityChannel.getChannelForMember(db, channelId, senderUserId),
    { route: "ws-do:agent-typing-membership" },
  )
  if (!membership) {
    context.log.warn("fanOutTyping: sender not a channel member", { senderUserId, channelId })
    return
  }
  if (membership.type === "thread" && !await withD1Retry(
    () => queries.communityThread.isThreadParticipant(db, channelId, senderUserId),
    { route: "ws-do:agent-typing-participation" },
  )) return
  const communication = await withD1Retry(
    () => canCommunicateInTypingScope(db, membership.type, channelId, senderUserId),
    { route: "ws-do:agent-typing-communication" },
  )
  if (!communication.ok) return

  if (membership.type === "dm") {
    if (!communication.dmPeerUserId || communication.dmPeerUserId === senderUserId) return
    const doId = context.env.WS_DO.idFromName("user:" + communication.dmPeerUserId)
    const stub = context.env.WS_DO.get(doId)
    await stub.fetch(createInternalBrowserBroadcastRequest(communication.dmPeerUserId, outboundEvent)).catch(() => { })
    return
  }

  const roomDoId = context.env.WS_DO.idFromName(channelRoomDoName(channelId))
  const roomStub = context.env.WS_DO.get(roomDoId)
  await roomStub.fetch(new Request("http://internal/room/typing", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ senderUserId, event: outboundEvent }),
  })).catch(() => { })
}

export async function fanOutTypingStop(
  context: WsDurableContext,
  senderUserId: string,
  channelId: string,
): Promise<void> {
  const db = createPrimaryDb(context.env.DB)
  const membership = await withD1Retry(
    () => queries.communityChannel.getChannelForMember(db, channelId, senderUserId),
    { route: "ws-do:agent-typing-stop-membership" },
  )
  if (!membership) {
    context.log.warn("fanOutTypingStop: sender not a channel member", { senderUserId, channelId })
    return
  }
  const communication = await withD1Retry(
    () => canCommunicateInTypingScope(db, membership.type, channelId, senderUserId),
    { route: "ws-do:agent-typing-stop-communication" },
  )
  if (!communication.ok) return
  const event = {
    type: WS_EVENTS.TYPING_STOP,
    channelId,
    userId: senderUserId,
  }
  if (membership.type === "dm") {
    if (!communication.dmPeerUserId || communication.dmPeerUserId === senderUserId) return
    const doId = context.env.WS_DO.idFromName("user:" + communication.dmPeerUserId)
    const stub = context.env.WS_DO.get(doId)
    await stub.fetch(createInternalBrowserBroadcastRequest(communication.dmPeerUserId, event)).catch(() => { })
    return
  }

  const roomDoId = context.env.WS_DO.idFromName(channelRoomDoName(channelId))
  const roomStub = context.env.WS_DO.get(roomDoId)
  await roomStub.fetch(new Request("http://internal/room/typing", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ senderUserId, event }),
  })).catch(() => { })
}

export async function broadcastPresence(
  context: WsDurableContext,
  userId: string,
  online: boolean,
): Promise<void> {
  await broadcastToAudience(context, userId, { type: WS_EVENTS.PRESENCE_UPDATE, userId, online })
}

async function listDirectPresencePeerIds(
  db: Database,
  userId: string,
): Promise<string[]> {
  const [friendIds, dmPeerIds] = await Promise.all([
    queries.communityFriendship.getFriendUserIds(db, userId),
    queries.communityDm.listDmPeerUserIds(db, userId),
  ])
  const unique = new Set<string>(friendIds)
  for (const peerId of dmPeerIds) {
    if (peerId && peerId !== userId) unique.add(peerId)
  }
  return [...unique]
}

export async function broadcastToAudience(
  context: WsDurableContext,
  userId: string,
  payload: unknown,
): Promise<void> {
  const normalized = normalizeBrowserPayload(context, payload)
  if (!normalized.ok) return
  const outboundPayload = normalized.payload as { type?: string; online?: boolean }
  const db = createDb(context.env.DB)
  const [serverIds, peerIds] = await Promise.all([
    queries.communityMember.listServerIdsForUser(db, userId),
    listDirectPresencePeerIds(db, userId),
  ])

  await settleInBatches(serverIds, async (serverId) => {
    const roomDoId = context.env.WS_DO.idFromName(serverRoomDoName(serverId))
    const roomStub = context.env.WS_DO.get(roomDoId)
    if (outboundPayload.type === WS_EVENTS.PRESENCE_UPDATE && typeof outboundPayload.online === "boolean") {
      await roomStub.fetch(new Request("http://internal/room/presence-change", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, online: outboundPayload.online }),
      }))
      return
    }
    await roomStub.fetch(new Request("http://internal/room/server-broadcast", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, event: outboundPayload }),
    }))
  }, context.subrequestBatchSize)

  await fanOutToRecipientsWithRelay(context, peerIds, outboundPayload)
}

export async function getPresenceAudience(
  context: WsDurableContext,
  userId: string,
): Promise<string[]> {
  const db = createDb(context.env.DB)
  return listDirectPresencePeerIds(db, userId)
}

export async function sendPresenceSnapshot(
  context: WsDurableContext,
  ws: WebSocket,
  userId: string,
): Promise<void> {
  const db = createDb(context.env.DB)
  const peerIds = await listDirectPresencePeerIds(db, userId)
  if (peerIds.length === 0) return

  const botUserIds = new Set<string>()
  const onlineBotUserIds = new Set<string>()
  for (let i = 0; i < peerIds.length; i += BOT_PRESENCE_D1_CHUNK_SIZE) {
    const chunk = peerIds.slice(i, i + BOT_PRESENCE_D1_CHUNK_SIZE)
    const state = await queries.communityMachine.getBotPresenceStates(db, chunk)
    for (const id of state.botUserIds) botUserIds.add(id)
    for (const id of state.onlineBotUserIds) onlineBotUserIds.add(id)
  }

  const humanPeerIds = peerIds.filter((id) => !botUserIds.has(id))
  const onlineHumanIds = await checkHumansOnlineWithRelay(context, humanPeerIds)
  sendPresenceSnapshotFrame(ws, [...onlineBotUserIds, ...onlineHumanIds])
}
