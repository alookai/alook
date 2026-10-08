import type { Presence as CommunityPresence } from "@/lib/community/models/people"
import { createStore } from "@tanstack/store"

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

type CommunityPresenceSnapshot = {
  viewerId: string | null
  accountEpoch: number
  revision: number
}
export type CommunityWsConnectionStatus = "connected" | "reconnecting" | "failed"

const NOOP_RECONNECT = () => undefined

type ChannelAccessScope = {
  serverId: string | null
  parentChannelId?: string | null
  generation: number
  revoked: boolean
}

type CommunityWsStoreState = {
  accessEpoch: number
  channelAccessScopes: Map<string, ChannelAccessScope>
  revokedServerIds: Set<string>
  beginChannelMembershipChange: (serverId: string | null, channelId: string) => number
  observeChannelScope: (serverId: string, channelId: string, parentChannelId?: string | null) => void
  rememberChannelAccess: (serverId: string | null, channelId: string, parentChannelId?: string | null) => void
  revokeChannelAccess: (serverId: string | null, channelId: string) => string[]
  revokeServerAccess: (serverId: string) => void
  grantServerAccess: (serverId: string) => void
  isChannelAccessRevoked: (channelId: string, serverId?: string | null, parentChannelId?: string) => boolean
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
  reset: () => void
}

const initialState = (): Pick<
  CommunityWsStoreState,
  "profileViewerId" | "profileAccountEpoch" | "presenceRevision"
  | "presenceByUserId" | "presenceRevisionsByUserId"
  | "seenMessageIds" | "seenDeliveryOperations"
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
})

export function createCommunityWsStore(viewerId: string | null) {
  const store = createStore(initialState(), ({ setState, get }): Omit<CommunityWsStoreState, keyof ReturnType<typeof initialState>> => {
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
    if (presenceByUserId || revisions) setState((state) => ({ ...state, ...{
      ...(presenceByUserId ? { presenceByUserId } : {}),
      ...(revisions ? { presenceRevision: revision, presenceRevisionsByUserId: revisions } : {}),
    } }))
    return true
  }

  return {
    activateProfileAccount: (viewerId) => {
      const state = get()
      if (state.profileViewerId === viewerId) return state.profileAccountEpoch
      const profileAccountEpoch = state.profileAccountEpoch + 1
      setState((state) => ({ ...state, ...{
        profileViewerId: viewerId,
        profileAccountEpoch,
        accessEpoch: state.accessEpoch + 1,
        channelAccessScopes: new Map(),
        revokedServerIds: new Set(),
        presenceRevision: 0,
        presenceByUserId: new Map(),
        presenceRevisionsByUserId: new Map(),
      } }))
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
      setState((state) => ({ ...state, ...{ seenMessageIds: trimmed } }))
      return
    }
    setState((state) => ({ ...state, ...{ seenMessageIds: next } }))
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
      setState((state) => ({ ...state, ...{
        seenDeliveryOperations: new Map(
          [...next].slice(-SEEN_DELIVERY_OPERATION_TRIM_TO),
        ),
      } }))
      return "new"
    }
    setState((state) => ({ ...state, ...{ seenDeliveryOperations: next } }))
    return "new"
  },

  completeDeliveryOperation: (operationId, operationDigest) => {
    const current = get().seenDeliveryOperations
    const observed = current.get(operationId)
    if (!observed || observed.digest !== operationDigest) return false
    if (observed.completed) return true
    const next = new Map(current)
    next.set(operationId, { ...observed, completed: true })
    setState((state) => ({ ...state, ...{ seenDeliveryOperations: next } }))
    return true
  },

  beginChannelMembershipChange: (serverId, channelId) => {
    const scopes = new Map(get().channelAccessScopes)
    const previous = scopes.get(channelId)
    const generation = (previous?.generation ?? 0) + 1
    scopes.set(channelId, { ...previous, serverId, revoked: false, generation })
    setState((state) => ({ ...state, ...{ channelAccessScopes: scopes } }))
    return generation
  },

  observeChannelScope: (serverId, channelId, parentChannelId) => {
    const previous = get().channelAccessScopes.get(channelId)
    if (previous?.serverId === serverId && (!parentChannelId || previous.parentChannelId === parentChannelId)) return
    const scopes = new Map(get().channelAccessScopes)
    scopes.set(channelId, { generation: 0, revoked: false, ...previous, serverId, ...(parentChannelId ? { parentChannelId } : {}) })
    setState((state) => ({ ...state, ...{ channelAccessScopes: scopes } }))
  },

  rememberChannelAccess: (serverId, channelId, parentChannelId) => {
    const scopes = new Map(get().channelAccessScopes)
    const previous = scopes.get(channelId)
    scopes.set(channelId, { serverId, parentChannelId, generation: previous?.generation ?? 0, revoked: false })
    if (parentChannelId && scopes.get(parentChannelId)?.revoked) {
      const parent = scopes.get(parentChannelId)!
      scopes.set(parentChannelId, { ...parent, revoked: false })
    }
    setState((state) => ({ ...state, ...{ channelAccessScopes: scopes } }))
  },

  revokeChannelAccess: (serverId, channelId) => {
    const scopes = new Map(get().channelAccessScopes)
    const affected = new Set([channelId])
    for (const [id, scope] of scopes) {
      if (scope.serverId === serverId && scope.parentChannelId === channelId) affected.add(id)
    }
    for (const id of affected) {
      const previous = scopes.get(id)
      scopes.set(id, { serverId, ...previous, generation: (previous?.generation ?? 0) + (previous?.revoked ? 0 : 1), revoked: true })
    }
    setState((state) => ({ ...state, ...{ channelAccessScopes: scopes } }))
    return [...affected]
  },

  revokeServerAccess: (serverId) => {
    const revokedServerIds = new Set(get().revokedServerIds).add(serverId)
    setState((state) => ({ ...state, ...{ revokedServerIds, accessEpoch: get().accessEpoch + 1 } }))
  },

  grantServerAccess: (serverId) => {
    const revokedServerIds = new Set(get().revokedServerIds)
    revokedServerIds.delete(serverId)
    setState((state) => ({ ...state, ...{ revokedServerIds } }))
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
    setState((state) => ({ ...state, ...{ accessConnected: false } }))
  },

  markAccessConnected: () => setState((state) => ({ ...state, ...{ accessConnected: true } })),

  setConnectionStatus: (connectionStatus) => {
    if (get().connectionStatus === connectionStatus) return
    setState((state) => ({ ...state, ...{ connectionStatus } }))
  },

  bindReconnectNow: (reconnectNow) => setState((state) => ({ ...state, ...{ reconnectNow } })),

    reset: () => setState((state) => ({ ...state, ...{
      ...initialState(),
      profileAccountEpoch: get().profileAccountEpoch + 1,
    } })),
  }
  })
  store.actions.activateProfileAccount(viewerId)
  return store
}
