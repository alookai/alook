import {
  isValidCommunityUserTarget,
  validateCommunityWsEvent,
  WS_EVENTS,
} from "@alook/shared"
import { createInternalBrowserBroadcastRequest } from "../internal-user-broadcast"
import { settleInBatches } from "../settle-in-batches"
import type { WsDurableContext } from "./internal"

const ROOM_HOP_MAX_RECIPIENTS = 399
const MAX_RELAY_HOPS = 25
const ROOM_ENTRY_TTL_MS = 30 * 60 * 1000

const SCOPE_ROOM_ACTIVE_VIEWERS_KEY = "scope-room:active-viewers"
const SCOPE_ROOM_ONLINE_USERS_KEY = "scope-room:online-users"

export type ScopeRoomState = {
  hydrated: boolean
  hydratePromise: Promise<void> | null
  activeViewers: Map<string, number>
  onlineUsers: Map<string, number>
}

export function createScopeRoomState(): ScopeRoomState {
  return {
    hydrated: false,
    hydratePromise: null,
    activeViewers: new Map(),
    onlineUsers: new Map(),
  }
}

export function serverRoomDoName(serverId: string): string {
  return `room:server:${serverId}`
}

export function channelRoomDoName(channelId: string): string {
  return `room:channel:${channelId}`
}

function relayBroadcastRoomDoName(hop: number): string {
  return `room:relay:broadcast:${hop}`
}

function relayPresenceRoomDoName(hop: number): string {
  return `room:relay:presence:${hop}`
}

function parseTimestampRecord(raw: unknown): Array<[string, number]> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return []
  const entries: Array<[string, number]> = []
  for (const [id, ts] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof ts === "number" && Number.isFinite(ts) && isValidCommunityUserTarget(id)) {
      entries.push([id, ts])
    }
  }
  return entries
}

async function ensureScopeRoomHydrated(context: WsDurableContext): Promise<ScopeRoomState> {
  const room = context.scopeRoom
  if (room.hydrated) return room
  if (!room.hydratePromise) {
    room.hydratePromise = (async () => {
      const storage = context.ctx.storage
      if (storage?.get) {
        try {
          const [storedViewers, storedOnline] = await Promise.all([
            storage.get<Record<string, number>>(SCOPE_ROOM_ACTIVE_VIEWERS_KEY),
            storage.get<Record<string, number>>(SCOPE_ROOM_ONLINE_USERS_KEY),
          ])
          for (const [id, ts] of parseTimestampRecord(storedViewers)) {
            const existing = room.activeViewers.get(id) ?? 0
            if (ts > existing) room.activeViewers.set(id, ts)
          }
          for (const [id, ts] of parseTimestampRecord(storedOnline)) {
            const existing = room.onlineUsers.get(id) ?? 0
            if (ts > existing) room.onlineUsers.set(id, ts)
          }
        } catch { }
      }
      room.hydrated = true
      room.hydratePromise = null
    })()
  }
  await room.hydratePromise
  return room
}

async function persistScopeRoomMap(
  context: WsDurableContext,
  key: string,
  map: Map<string, number>,
): Promise<void> {
  const storage = context.ctx.storage
  if (!storage?.put) return
  try {
    if (map.size === 0 && storage.delete) {
      await storage.delete(key)
      return
    }
    await storage.put(key, Object.fromEntries(map))
  } catch { }
}

function pruneStale(map: Map<string, number>, now: number): boolean {
  const cutoff = now - ROOM_ENTRY_TTL_MS
  let changed = false
  for (const [id, updatedAt] of map) {
    if (updatedAt < cutoff) {
      map.delete(id)
      changed = true
    }
  }
  return changed
}

export async function fanOutToRecipientsWithRelay(
  context: WsDurableContext,
  recipients: readonly string[],
  payload: unknown,
  hop = 0,
): Promise<number> {
  if (recipients.length === 0) return 0
  const direct = recipients.slice(0, ROOM_HOP_MAX_RECIPIENTS)
  const remainder = recipients.slice(ROOM_HOP_MAX_RECIPIENTS)
  const results = await settleInBatches(direct, async (viewerId) => {
    const doId = context.env.WS_DO.idFromName("user:" + viewerId)
    const stub = context.env.WS_DO.get(doId)
    await stub.fetch(createInternalBrowserBroadcastRequest(viewerId, payload))
  }, context.subrequestBatchSize)
  let notified = results.filter((result) => result.status === "fulfilled").length

  if (remainder.length > 0 && hop < MAX_RELAY_HOPS) {
    try {
      const nextHop = hop + 1
      const relayId = context.env.WS_DO.idFromName(relayBroadcastRoomDoName(nextHop))
      const relayStub = context.env.WS_DO.get(relayId)
      const resp = await relayStub.fetch(new Request("http://internal/room/relay-broadcast", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recipients: remainder, payload, hop: nextHop }),
      }))
      if (resp.ok) {
        const data = await resp.json() as { notified?: unknown }
        if (typeof data.notified === "number" && Number.isFinite(data.notified)) {
          notified += data.notified
        }
      }
    } catch { }
  }
  return notified
}

export async function checkHumansOnlineWithRelay(
  context: WsDurableContext,
  userIds: readonly string[],
  hop = 0,
): Promise<string[]> {
  if (userIds.length === 0) return []
  const direct = userIds.slice(0, ROOM_HOP_MAX_RECIPIENTS)
  const remainder = userIds.slice(ROOM_HOP_MAX_RECIPIENTS)

  const checks = await settleInBatches(direct, async (memberId) => {
    const doId = context.env.WS_DO.idFromName("user:" + memberId)
    const stub = context.env.WS_DO.get(doId)
    const resp = await stub.fetch(
      new Request(`http://internal/check-user-online?userId=${encodeURIComponent(memberId)}`),
    )
    const data = await resp.json() as { online: boolean; stale?: boolean }
    if (data.stale) return null
    return data.online ? memberId : null
  }, context.subrequestBatchSize)

  const onlineIds: string[] = []
  for (const result of checks) {
    if (result.status === "fulfilled" && result.value) onlineIds.push(result.value)
  }

  if (remainder.length > 0 && hop < MAX_RELAY_HOPS) {
    try {
      const nextHop = hop + 1
      const relayId = context.env.WS_DO.idFromName(relayPresenceRoomDoName(nextHop))
      const relayStub = context.env.WS_DO.get(relayId)
      const resp = await relayStub.fetch(new Request("http://internal/room/relay-presence-check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userIds: remainder, hop: nextHop }),
      }))
      if (resp.ok) {
        const data = await resp.json() as { onlineUserIds?: unknown }
        if (Array.isArray(data.onlineUserIds)) {
          for (const id of data.onlineUserIds) {
            if (typeof id === "string") onlineIds.push(id)
          }
        }
      }
    } catch { }
  }
  return onlineIds
}

export async function handleScopeRoomFetch(
  context: WsDurableContext,
  request: Request,
  url: URL,
): Promise<Response | null> {
  if (request.method !== "POST") return null

  if (url.pathname === "/room/focus") {
    let body: { userId?: unknown; active?: unknown; includeSnapshot?: unknown }
    try {
      body = await request.json() as typeof body
    } catch {
      return Response.json({ error: "invalid json" }, { status: 400 })
    }
    if (!isValidCommunityUserTarget(body.userId) || typeof body.active !== "boolean") {
      return Response.json({ error: "invalid focus payload" }, { status: 400 })
    }
    const now = Date.now()
    const room = await ensureScopeRoomHydrated(context)
    pruneStale(room.activeViewers, now)
    const onlinePruned = pruneStale(room.onlineUsers, now)
    if (body.active) {
      room.activeViewers.set(body.userId, now)
    } else {
      room.activeViewers.delete(body.userId)
    }
    await persistScopeRoomMap(context, SCOPE_ROOM_ACTIVE_VIEWERS_KEY, room.activeViewers)
    if (onlinePruned) {
      await persistScopeRoomMap(context, SCOPE_ROOM_ONLINE_USERS_KEY, room.onlineUsers)
    }
    const onlineUserIds = body.includeSnapshot === true
      ? [...room.onlineUsers.keys()].filter((id) => id !== body.userId)
      : undefined
    return Response.json({ ok: true, ...(onlineUserIds ? { onlineUserIds } : {}) })
  }

  if (url.pathname === "/room/presence-change") {
    let body: { userId?: unknown; online?: unknown }
    try {
      body = await request.json() as typeof body
    } catch {
      return Response.json({ error: "invalid json" }, { status: 400 })
    }
    if (!isValidCommunityUserTarget(body.userId) || typeof body.online !== "boolean") {
      return Response.json({ error: "invalid presence payload" }, { status: 400 })
    }
    const now = Date.now()
    const room = await ensureScopeRoomHydrated(context)
    const viewersPruned = pruneStale(room.activeViewers, now)
    pruneStale(room.onlineUsers, now)
    if (body.online) {
      room.onlineUsers.set(body.userId, now)
    } else {
      room.onlineUsers.delete(body.userId)
    }
    await persistScopeRoomMap(context, SCOPE_ROOM_ONLINE_USERS_KEY, room.onlineUsers)
    if (viewersPruned) {
      await persistScopeRoomMap(context, SCOPE_ROOM_ACTIVE_VIEWERS_KEY, room.activeViewers)
    }
    const recipients = [...room.activeViewers.keys()].filter((id) => id !== body.userId)
    const event = {
      type: WS_EVENTS.PRESENCE_UPDATE,
      userId: body.userId,
      online: body.online,
    }
    const notified = await fanOutToRecipientsWithRelay(context, recipients, event)
    return Response.json({ ok: true, notified })
  }

  if (url.pathname === "/room/presence-renew") {
    let body: { userId?: unknown }
    try {
      body = await request.json() as typeof body
    } catch {
      return Response.json({ error: "invalid json" }, { status: 400 })
    }
    if (!isValidCommunityUserTarget(body.userId)) {
      return Response.json({ error: "invalid presence renew payload" }, { status: 400 })
    }
    const now = Date.now()
    const room = await ensureScopeRoomHydrated(context)
    pruneStale(room.onlineUsers, now)
    room.onlineUsers.set(body.userId, now)
    await persistScopeRoomMap(context, SCOPE_ROOM_ONLINE_USERS_KEY, room.onlineUsers)
    return Response.json({ ok: true })
  }

  if (url.pathname === "/room/server-broadcast") {
    let body: { userId?: unknown; event?: unknown }
    try {
      body = await request.json() as typeof body
    } catch {
      return Response.json({ error: "invalid json" }, { status: 400 })
    }
    if (!isValidCommunityUserTarget(body.userId)) {
      return Response.json({ error: "invalid server broadcast payload" }, { status: 400 })
    }
    const normalized = validateCommunityWsEvent(body.event)
    if (!normalized.ok) {
      return Response.json({ error: "invalid server broadcast event" }, { status: 400 })
    }
    const now = Date.now()
    const room = await ensureScopeRoomHydrated(context)
    const viewersPruned = pruneStale(room.activeViewers, now)
    if (viewersPruned) {
      await persistScopeRoomMap(context, SCOPE_ROOM_ACTIVE_VIEWERS_KEY, room.activeViewers)
    }
    const recipients = [...room.activeViewers.keys()].filter((id) => id !== body.userId)
    const notified = await fanOutToRecipientsWithRelay(context, recipients, normalized.event)
    return Response.json({ ok: true, notified })
  }

  if (url.pathname === "/room/typing") {
    let body: { senderUserId?: unknown; event?: unknown }
    try {
      body = await request.json() as typeof body
    } catch {
      return Response.json({ error: "invalid json" }, { status: 400 })
    }
    if (!isValidCommunityUserTarget(body.senderUserId)) {
      return Response.json({ error: "invalid typing payload" }, { status: 400 })
    }
    const normalized = validateCommunityWsEvent(body.event)
    if (!normalized.ok || (normalized.event.type !== WS_EVENTS.TYPING_START && normalized.event.type !== WS_EVENTS.TYPING_STOP)) {
      return Response.json({ error: "invalid typing event" }, { status: 400 })
    }
    const now = Date.now()
    const room = await ensureScopeRoomHydrated(context)
    const viewersPruned = pruneStale(room.activeViewers, now)
    if (viewersPruned) {
      await persistScopeRoomMap(context, SCOPE_ROOM_ACTIVE_VIEWERS_KEY, room.activeViewers)
    }
    const recipients = [...room.activeViewers.keys()].filter((id) => id !== body.senderUserId)
    const notified = await fanOutToRecipientsWithRelay(context, recipients, normalized.event)
    return Response.json({ ok: true, notified })
  }

  if (url.pathname === "/room/relay-broadcast") {
    let body: { recipients?: unknown; payload?: unknown; hop?: unknown }
    try {
      body = await request.json() as typeof body
    } catch {
      return Response.json({ error: "invalid json" }, { status: 400 })
    }
    if (!Array.isArray(body.recipients) || !body.recipients.every((id) => isValidCommunityUserTarget(id))) {
      return Response.json({ error: "invalid relay recipients" }, { status: 400 })
    }
    const hop = typeof body.hop === "number" && Number.isInteger(body.hop) && body.hop >= 0 && body.hop <= MAX_RELAY_HOPS
      ? body.hop
      : null
    if (hop === null) {
      return Response.json({ error: "invalid relay hop" }, { status: 400 })
    }
    const normalized = validateCommunityWsEvent(body.payload)
    if (!normalized.ok) {
      return Response.json({ error: "invalid relay payload" }, { status: 400 })
    }
    const notified = await fanOutToRecipientsWithRelay(context, body.recipients, normalized.event, hop)
    return Response.json({ ok: true, notified })
  }

  if (url.pathname === "/room/relay-presence-check") {
    let body: { userIds?: unknown; hop?: unknown }
    try {
      body = await request.json() as typeof body
    } catch {
      return Response.json({ error: "invalid json" }, { status: 400 })
    }
    if (!Array.isArray(body.userIds) || !body.userIds.every((id) => isValidCommunityUserTarget(id))) {
      return Response.json({ error: "invalid relay userIds" }, { status: 400 })
    }
    const hop = typeof body.hop === "number" && Number.isInteger(body.hop) && body.hop >= 0 && body.hop <= MAX_RELAY_HOPS
      ? body.hop
      : null
    if (hop === null) {
      return Response.json({ error: "invalid relay hop" }, { status: 400 })
    }
    const onlineUserIds = await checkHumansOnlineWithRelay(context, body.userIds, hop)
    return Response.json({ ok: true, onlineUserIds })
  }

  return null
}
