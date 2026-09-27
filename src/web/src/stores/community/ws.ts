"use client"

import { create } from "zustand"
import type { CommunityBotAuditEvent } from "@alook/shared"

/**
 * Zustand store for community WS-live-patched state.
 *
 * Owned exclusively by the WS handler (`hooks/community/use-community-ws.ts`)
 * Durable profile fields live in the canonical TanStack DB collection. This
 * store retains only the WS generation guards and transient overlays such as
 * presence, so a presence tick does not rewrite the persisted profile row.
 *
 * Loop-breaker rules (short version — full rulebook lives in `./index.ts`):
 * - Setters no-op on identical projected values. Zustand notifies every
 *   subscriber on every `set(...)`; redundant seeds keep the map reference.
 * - Effect writers into this store must pass reference-stable arguments —
 *   a fresh `[]` fallback per render will trigger the seeder each pass and
 *   without the guards above would loop.
 */

// Cap the seen-message set to bound memory. Mirrors the current dedup logic
// in `hooks/community/use-community-ws.ts` (grow to 500, trim to the newest
// 400). Extracted as constants so the tests can assert the boundary directly.
export const SEEN_MESSAGE_MAX = 500
export const SEEN_MESSAGE_TRIM_TO = 400
export const SEEN_DELIVERY_OPERATION_MAX = 500
export const SEEN_DELIVERY_OPERATION_TRIM_TO = 400

type DeliveryOperationObservationResult = "new" | "retryable" | "duplicate" | "conflict"
type DeliveryOperationState = {
  digest: string
  completed: boolean
}

/**
 * Bounded ring for live bot-audit events, PER bot. The modal reads from here
 * and prepends into the React Query cache — the ring only holds enough for
 * the "in-flight" window while the modal is open. Older events are always
 * available via paginated GETs. Per-bot bounding prevents a chatty bot from
 * evicting a quiet bot's live events before the modal for that bot mounts.
 */
export const BOT_AUDIT_RING_MAX = 200

export type BotAuditEventEntry = {
  id: string
  botId: string
  kind: CommunityBotAuditEvent["kind"]
  payload: unknown
  sessionId?: string | null
  launchId?: string | null
  createdAt: string
}

export type CommunityPresence = "online" | "offline"
export type CommunityPresenceSnapshot = {
  viewerId: string | null
  accountEpoch: number
  revision: number
}
export type CommunityWsConnectionStatus = "connected" | "reconnecting" | "failed"

const NOOP_RECONNECT = () => undefined

type ChannelAccessScope = {
  serverId: string
  parentChannelId?: string | null
  generation: number
  revoked: boolean
}

export type CommunityWsStoreState = {
  accessEpoch: number
  channelAccessScopes: Map<string, ChannelAccessScope>
  revokedServerIds: Set<string>
  beginChannelMembershipChange: (serverId: string, channelId: string) => number
  observeChannelScope: (serverId: string, channelId: string, parentChannelId?: string | null) => void
  rememberChannelAccess: (serverId: string, channelId: string, parentChannelId?: string | null) => void
  revokeChannelAccess: (serverId: string, channelId: string) => string[]
  revokeServerAccess: (serverId: string) => void
  grantServerAccess: (serverId: string) => void
  isChannelAccessRevoked: (channelId: string, serverId?: string, parentChannelId?: string) => boolean
  accessConnected: boolean
  connectionStatus: CommunityWsConnectionStatus
  reconnectNow: () => void
  profileViewerId: string | null
  profileAccountEpoch: number
  presenceRevision: number
  presenceByUserId: Map<string, CommunityPresence>
  presenceRevisionsByUserId: Map<string, number>
  seenMessageIds: Set<string>
  seenDeliveryOperations: Map<string, DeliveryOperationState>
  /**
   * Per-bot rings of recent audit events, each bounded by BOT_AUDIT_RING_MAX.
   * Newest first inside each bot's array. A chatty bot never evicts a quieter
   * bot's events. Absent-bot lookup returns an empty array.
   */
  botAuditEvents: Map<string, BotAuditEventEntry[]>

  activateProfileAccount: (viewerId: string | null) => number
  beginPresenceSnapshot: () => CommunityPresenceSnapshot
  seedPresence: (
    snapshot: CommunityPresenceSnapshot,
    patches: ReadonlyMap<string, CommunityPresence> | readonly [string, CommunityPresence][],
  ) => boolean
  setPresence: (userId: string, presence: CommunityPresence) => boolean
  hasSeenMessage: (id: string) => boolean
  markSeenMessage: (id: string) => void
  observeDeliveryOperation: (
    operationId: string,
    operationDigest: string,
  ) => DeliveryOperationObservationResult
  completeDeliveryOperation: (operationId: string, operationDigest: string) => boolean
  markAccessDisconnected: () => void
  markAccessConnected: () => void
  setConnectionStatus: (status: CommunityWsConnectionStatus) => void
  bindReconnectNow: (reconnectNow: () => void) => void
  pushBotAuditEvent: (event: BotAuditEventEntry) => void
  reset: () => void
}

const initialState = (): Pick<
  CommunityWsStoreState,
  "profileViewerId" | "profileAccountEpoch" | "presenceRevision"
  | "presenceByUserId" | "presenceRevisionsByUserId"
  | "seenMessageIds" | "seenDeliveryOperations" | "botAuditEvents"
  | "accessEpoch" | "accessConnected" | "channelAccessScopes" | "revokedServerIds"
  | "connectionStatus" | "reconnectNow"
> => ({
  accessEpoch: 0,
  channelAccessScopes: new Map(),
  revokedServerIds: new Set(),
  accessConnected: false,
  connectionStatus: "connected",
  reconnectNow: NOOP_RECONNECT,
  profileViewerId: null,
  profileAccountEpoch: 0,
  presenceRevision: 0,
  presenceByUserId: new Map(),
  presenceRevisionsByUserId: new Map(),
  seenMessageIds: new Set(),
  seenDeliveryOperations: new Map(),
  botAuditEvents: new Map(),
})

export const useCommunityWsStore = create<CommunityWsStoreState>((set, get) => {
  const writePresence = (
    snapshot: CommunityPresenceSnapshot,
    patches: ReadonlyMap<string, CommunityPresence> | readonly [string, CommunityPresence][],
    guardSnapshot: boolean,
  ) => {
    const state = get()
    if (
      !snapshot.viewerId
      || snapshot.viewerId !== state.profileViewerId
      || snapshot.accountEpoch !== state.profileAccountEpoch
    ) return false
    const entries = patches instanceof Map ? patches.entries() : patches
    const revision = state.presenceRevision + 1
    let presenceByUserId: Map<string, CommunityPresence> | null = null
    let revisions: Map<string, number> | null = null
    for (const [userId, presence] of entries) {
      const previousRevision = state.presenceRevisionsByUserId.get(userId) ?? 0
      if (guardSnapshot && previousRevision > snapshot.revision) continue
      if ((presenceByUserId ?? state.presenceByUserId).get(userId) !== presence) {
        presenceByUserId ??= new Map(state.presenceByUserId)
        presenceByUserId.set(userId, presence)
      }
      if (!guardSnapshot) {
        revisions ??= new Map(state.presenceRevisionsByUserId)
        revisions.set(userId, revision)
      }
    }
    if (presenceByUserId || revisions) set({
      ...(presenceByUserId ? { presenceByUserId } : {}),
      ...(revisions ? { presenceRevision: revision, presenceRevisionsByUserId: revisions } : {}),
    })
    return true
  }

  return {
    ...initialState(),

    activateProfileAccount: (viewerId) => {
      const state = get()
      if (state.profileViewerId === viewerId) return state.profileAccountEpoch
      const profileAccountEpoch = state.profileAccountEpoch + 1
      set({
        profileViewerId: viewerId,
        profileAccountEpoch,
        accessEpoch: state.accessEpoch + 1,
        channelAccessScopes: new Map(),
        revokedServerIds: new Set(),
        presenceRevision: 0,
        presenceByUserId: new Map(),
        presenceRevisionsByUserId: new Map(),
      })
      return profileAccountEpoch
    },

    beginPresenceSnapshot: () => ({
      viewerId: get().profileViewerId,
      accountEpoch: get().profileAccountEpoch,
      revision: get().presenceRevision,
    }),

    seedPresence: (snapshot, patches) => writePresence(snapshot, patches, true),
    setPresence: (userId, presence) => writePresence(
      {
        viewerId: get().profileViewerId,
        accountEpoch: get().profileAccountEpoch,
        revision: get().presenceRevision,
      },
      [[userId, presence]],
      false,
    ),

  hasSeenMessage: (id) => get().seenMessageIds.has(id),

  markSeenMessage: (id) => {
    const current = get().seenMessageIds
    if (current.has(id)) return
    const next = new Set(current)
    next.add(id)
    if (next.size > SEEN_MESSAGE_MAX) {
      // Sliding window: drop the oldest entries so the newest survive.
      const trimmed = new Set([...next].slice(-SEEN_MESSAGE_TRIM_TO))
      set({ seenMessageIds: trimmed })
      return
    }
    set({ seenMessageIds: next })
  },

  observeDeliveryOperation: (operationId, operationDigest) => {
    const current = get().seenDeliveryOperations
    const observed = current.get(operationId)
    if (observed !== undefined) {
      if (observed.digest !== operationDigest) return "conflict"
      return observed.completed ? "duplicate" : "retryable"
    }
    const next = new Map(current)
    next.set(operationId, { digest: operationDigest, completed: false })
    if (next.size > SEEN_DELIVERY_OPERATION_MAX) {
      set({
        seenDeliveryOperations: new Map(
          [...next].slice(-SEEN_DELIVERY_OPERATION_TRIM_TO),
        ),
      })
      return "new"
    }
    set({ seenDeliveryOperations: next })
    return "new"
  },

  completeDeliveryOperation: (operationId, operationDigest) => {
    const current = get().seenDeliveryOperations
    const observed = current.get(operationId)
    if (!observed || observed.digest !== operationDigest) return false
    if (observed.completed) return true
    const next = new Map(current)
    next.set(operationId, { ...observed, completed: true })
    set({ seenDeliveryOperations: next })
    return true
  },

  beginChannelMembershipChange: (serverId, channelId) => {
    const scopes = new Map(get().channelAccessScopes)
    const previous = scopes.get(channelId)
    const generation = (previous?.generation ?? 0) + 1
    scopes.set(channelId, { serverId, revoked: false, ...previous, generation })
    set({ channelAccessScopes: scopes })
    return generation
  },

  observeChannelScope: (serverId, channelId, parentChannelId) => {
    const previous = get().channelAccessScopes.get(channelId)
    if (previous?.serverId === serverId && (!parentChannelId || previous.parentChannelId === parentChannelId)) return
    const scopes = new Map(get().channelAccessScopes)
    scopes.set(channelId, { generation: 0, revoked: false, ...previous, serverId, ...(parentChannelId ? { parentChannelId } : {}) })
    set({ channelAccessScopes: scopes })
  },

  rememberChannelAccess: (serverId, channelId, parentChannelId) => {
    const scopes = new Map(get().channelAccessScopes)
    const previous = scopes.get(channelId)
    scopes.set(channelId, { serverId, parentChannelId, generation: previous?.generation ?? 0, revoked: false })
    if (parentChannelId && scopes.get(parentChannelId)?.revoked) {
      const parent = scopes.get(parentChannelId)!
      scopes.set(parentChannelId, { ...parent, revoked: false })
    }
    set({ channelAccessScopes: scopes })
  },

  revokeChannelAccess: (serverId, channelId) => {
    const scopes = new Map(get().channelAccessScopes)
    const affected = new Set([channelId])
    for (const [id, scope] of scopes) {
      if (scope.serverId === serverId && scope.parentChannelId === channelId) affected.add(id)
    }
    for (const id of affected) {
      const previous = scopes.get(id)
      scopes.set(id, { serverId, ...previous, generation: (previous?.generation ?? 0) + 1, revoked: true })
    }
    set({ channelAccessScopes: scopes, accessEpoch: get().accessEpoch + 1 })
    return [...affected]
  },

  revokeServerAccess: (serverId) => {
    const revokedServerIds = new Set(get().revokedServerIds).add(serverId)
    set({ revokedServerIds, accessEpoch: get().accessEpoch + 1 })
  },

  grantServerAccess: (serverId) => {
    const revokedServerIds = new Set(get().revokedServerIds)
    revokedServerIds.delete(serverId)
    set({ revokedServerIds })
  },

  isChannelAccessRevoked: (channelId, serverId, parentChannelId) => {
    const state = get()
    const scope = state.channelAccessScopes.get(channelId)
    const server = serverId ?? scope?.serverId
    const parent = parentChannelId ?? scope?.parentChannelId
    return Boolean(scope?.revoked
      || (server && state.revokedServerIds.has(server))
      || (parent && state.channelAccessScopes.get(parent)?.revoked))
  },

  markAccessDisconnected: () => {
    const state = get()
    if (!state.accessConnected) return
    set({ accessConnected: false })
  },

  markAccessConnected: () => set({ accessConnected: true }),

  setConnectionStatus: (connectionStatus) => {
    if (get().connectionStatus === connectionStatus) return
    set({ connectionStatus })
  },

  bindReconnectNow: (reconnectNow) => set({ reconnectNow }),

  pushBotAuditEvent: (event) => {
    const current = get().botAuditEvents
    const perBot = current.get(event.botId) ?? []
    // Dedup by id — the same event can arrive via WS *and* be in the initial
    // GET response (the plan's cache-race case); the hook does its own
    // per-cache dedup too, but keeping the store honest costs nothing.
    if (perBot.some((e) => e.id === event.id)) return
    const nextPerBot = [event, ...perBot]
    if (nextPerBot.length > BOT_AUDIT_RING_MAX) nextPerBot.length = BOT_AUDIT_RING_MAX
    const next = new Map(current)
    next.set(event.botId, nextPerBot)
    set({ botAuditEvents: next })
  },

    reset: () => set({
      ...initialState(),
      profileAccountEpoch: get().profileAccountEpoch + 1,
    }),
  }
})

const EMPTY_AUDIT_EVENTS: BotAuditEventEntry[] = []

/**
 * Live bot-audit events for a single botId. Newest first.
 *
 * The zustand selector reads only the per-bot slice of the ring map — a
 * presence/status update, or an event for a different bot, doesn't force a
 * re-render because zustand short-circuits on `Object.is` identity.
 */
export const useBotAuditEventsForBot = (botId: string | null | undefined): BotAuditEventEntry[] => {
  return useCommunityWsStore((s) =>
    botId ? s.botAuditEvents.get(botId) ?? EMPTY_AUDIT_EVENTS : EMPTY_AUDIT_EVENTS,
  )
}
