import {
  isValidCommunityUserTarget,
  validateCommunityWsEvent,
  WS_EVENTS,
} from "@alook/shared"
import { createInternalBrowserBroadcastRequest } from "../internal-user-broadcast"
import { settleInBatches } from "../settle-in-batches"
import type { WsDurableContext } from "./internal"

const ROOM_HOP_MAX_RECIPIENTS = 399
const BATCH_PRESENCE_HOP_MAX_TARGETS = 400
const MAX_RELAY_HOPS = 25
const ROOM_ENTRY_TTL_MS = 30 * 60 * 1000

const SCOPE_ROOM_ACTIVE_VIEWERS_KEY = "scope-room:active-viewers"
const SCOPE_ROOM_ONLINE_USERS_KEY = "scope-room:online-users"

type BatchPresenceFailureKind = "throw" | "non-ok" | "invalid-json" | "invalid-body"

type BatchPresenceFailureCounts = Record<BatchPresenceFailureKind, number>

type BatchPresenceHopResult = {
  online: string[]
  offline: string[]
  staleCount: number
  failureCount: number
  failureCounts: BatchPresenceFailureCounts
  resultCount: number
  maxActive: number
  batchCount: number
}

function relayBatchPresenceRoomDoName(hop: number): string {
  return `room:relay:batch-presence:${hop}`
}

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
      }
      room.hydrated = true
    })().finally(() => {
      room.hydratePromise = null
    })
  }
  await room.hydratePromise
  return room
}

async function hydrateScopeRoomOr503(
  context: WsDurableContext,
  path: string,
): Promise<{ ok: true; room: ScopeRoomState } | { ok: false; response: Response }> {
  try {
    return { ok: true, room: await ensureScopeRoomHydrated(context) }
  } catch (err) {
    context.log.warn("scope_room_hydrate_failed", { path, err: String(err) })
    return { ok: false, response: Response.json({ error: "scope room storage unavailable" }, { status: 503 }) }
  }
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

type BatchPresenceTargetResult =
  | { kind: "online" }
  | { kind: "offline" }
  | { kind: "stale" }
  | { kind: "non-ok"; status: number }
  | { kind: "invalid-json"; status: number }
  | { kind: "invalid-body"; status: number }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

async function checkBatchPresenceTarget(env: Env, userId: string): Promise<BatchPresenceTargetResult> {
  const doId = env.WS_DO.idFromName("user:" + userId)
  const stub = env.WS_DO.get(doId)
  const response = await stub.fetch(
    new Request(`http://internal/check-user-online?userId=${encodeURIComponent(userId)}`),
  )
  if (!response.ok) return { kind: "non-ok", status: response.status }

  let data: unknown
  try {
    data = await response.json()
  } catch {
    return { kind: "invalid-json", status: response.status }
  }
  if (
    !isRecord(data)
    || typeof data.online !== "boolean"
    || (data.stale !== undefined && typeof data.stale !== "boolean")
  ) return { kind: "invalid-body", status: response.status }
  if (data.stale) return { kind: "stale" }
  return data.online ? { kind: "online" } : { kind: "offline" }
}

export async function checkBatchPresenceTargetsWithRelay(
  env: Env,
  userIds: readonly string[],
  options: {
    batchSize: number
    hop?: number
    onTargetFailure?: (userId: string, failureKind: BatchPresenceFailureKind, status?: number) => void
  },
): Promise<BatchPresenceHopResult> {
  const hop = options.hop ?? 0
  const direct = userIds.slice(0, BATCH_PRESENCE_HOP_MAX_TARGETS)
  const remainder = userIds.slice(BATCH_PRESENCE_HOP_MAX_TARGETS)

  let active = 0
  let maxActive = 0
  const results = await settleInBatches(direct, async (id) => {
    active += 1
    maxActive = Math.max(maxActive, active)
    try {
      return await checkBatchPresenceTarget(env, id)
    } finally {
      active -= 1
    }
  }, options.batchSize)

  const online: string[] = []
  const offline: string[] = []
  let staleCount = 0
  let failureCount = 0
  const failureCounts: BatchPresenceFailureCounts = {
    throw: 0,
    "non-ok": 0,
    "invalid-json": 0,
    "invalid-body": 0,
  }
  for (const [index, result] of results.entries()) {
    const id = direct[index]!
    if (result.status === "rejected") {
      failureCount += 1
      failureCounts.throw += 1
      options.onTargetFailure?.(id, "throw")
      continue
    }
    if (result.value.kind === "online") {
      online.push(id)
    } else if (result.value.kind === "offline") {
      offline.push(id)
    } else if (result.value.kind === "stale") {
      staleCount += 1
    } else {
      failureCount += 1
      failureCounts[result.value.kind] += 1
      options.onTargetFailure?.(id, result.value.kind, result.value.status)
    }
  }

  let resultCount = results.length
  let batchCount = Math.ceil(direct.length / options.batchSize)

  if (remainder.length > 0 && hop < MAX_RELAY_HOPS) {
    const nextHop = hop + 1
    const relayId = env.WS_DO.idFromName(relayBatchPresenceRoomDoName(nextHop))
    const relayStub = env.WS_DO.get(relayId)
    try {
      const resp = await relayStub.fetch(new Request("http://internal/room/relay-batch-presence", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userIds: remainder, hop: nextHop }),
      }))
      if (resp.ok) {
        const data = await resp.json() as Partial<BatchPresenceHopResult>
        if (Array.isArray(data.online)) {
          for (const id of data.online) {
            if (typeof id === "string") online.push(id)
          }
        }
        if (Array.isArray(data.offline)) {
          for (const id of data.offline) {
            if (typeof id === "string") offline.push(id)
          }
        }
        if (typeof data.staleCount === "number" && Number.isFinite(data.staleCount)) {
          staleCount += data.staleCount
        }
        if (typeof data.failureCount === "number" && Number.isFinite(data.failureCount)) {
          failureCount += data.failureCount
        }
        if (isRecord(data.failureCounts)) {
          for (const kind of ["throw", "non-ok", "invalid-json", "invalid-body"] as const) {
            const count = data.failureCounts[kind]
            if (typeof count === "number" && Number.isFinite(count)) {
              failureCounts[kind] += count
            }
          }
        }
        if (typeof data.resultCount === "number" && Number.isFinite(data.resultCount)) {
          resultCount += data.resultCount
        }
        if (typeof data.maxActive === "number" && Number.isFinite(data.maxActive)) {
          maxActive = Math.max(maxActive, data.maxActive)
        }
        if (typeof data.batchCount === "number" && Number.isFinite(data.batchCount)) {
          batchCount += data.batchCount
        }
      } else {
        failureCount += remainder.length
        failureCounts["non-ok"] += remainder.length
      }
    } catch {
      failureCount += remainder.length
      failureCounts.throw += remainder.length
    }
  }

  return {
    online,
    offline,
    staleCount,
    failureCount,
    failureCounts,
    resultCount,
    maxActive,
    batchCount,
  }
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
    const hydrated = await hydrateScopeRoomOr503(context, url.pathname)
    if (!hydrated.ok) return hydrated.response
    const { room } = hydrated
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
    const hydrated = await hydrateScopeRoomOr503(context, url.pathname)
    if (!hydrated.ok) return hydrated.response
    const { room } = hydrated
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
    const hydrated = await hydrateScopeRoomOr503(context, url.pathname)
    if (!hydrated.ok) return hydrated.response
    const { room } = hydrated
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
    const hydrated = await hydrateScopeRoomOr503(context, url.pathname)
    if (!hydrated.ok) return hydrated.response
    const { room } = hydrated
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
    const hydrated = await hydrateScopeRoomOr503(context, url.pathname)
    if (!hydrated.ok) return hydrated.response
    const { room } = hydrated
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

  if (url.pathname === "/room/relay-batch-presence") {
    let body: { userIds?: unknown; hop?: unknown }
    try {
      body = await request.json() as typeof body
    } catch {
      return Response.json({ error: "invalid json" }, { status: 400 })
    }
    if (
      !Array.isArray(body.userIds)
      || !body.userIds.every((id): id is string => typeof id === "string" && id.length > 0)
    ) {
      return Response.json({ error: "invalid relay userIds" }, { status: 400 })
    }
    const hop = typeof body.hop === "number" && Number.isInteger(body.hop) && body.hop >= 1 && body.hop <= MAX_RELAY_HOPS
      ? body.hop
      : null
    if (hop === null) {
      return Response.json({ error: "invalid relay hop" }, { status: 400 })
    }
    const result = await checkBatchPresenceTargetsWithRelay(context.env, body.userIds, {
      batchSize: context.subrequestBatchSize,
      hop,
    })
    return Response.json({ ok: true, ...result })
  }

  return null
}
