import type { Presence as CommunityPresence } from "@/lib/community/models/people"
import { createStore } from "@tanstack/store"
import type { CommunityApiError } from "@/lib/errors"

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
  denialCode?: CommunityApiError["code"]
}

export type CommunityWsStoreState = {
  accessEpoch: number
  serverAccessGenerations: Map<string, number>
  channelAccessScopes: Map<string, ChannelAccessScope>
  revokedServerIds: Set<string>
  beginChannelMembershipChange: (serverId: string | null, channelId: string, options?: { preserveRevocation: boolean }) => number
  observeChannelScope: (serverId: string, channelId: string, parentChannelId?: string | null) => void
  rememberChannelAccess: (serverId: string | null, channelId: string, parentChannelId?: string | null) => void
  revokeChannelAccess: (serverId: string | null, channelId: string, denialCode?: CommunityApiError["code"]) => string[]
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
  setPresenceBatch: (
    patches: ReadonlyMap<string, CommunityPresence> | readonly [string, CommunityPresence][],
  ) => boolean
  forgetPresence: (userId: string) => void
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
  | "accessEpoch" | "accessConnected" | "channelAccessScopes" | "revokedServerIds" | "serverAccessGenerations"
  | "connectionStatus" | "reconnectNow"
> => ({
  accessEpoch: 0,
  serverAccessGenerations: new Map(),
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

export function communityScopeAllowsAccess(
  state: Pick<CommunityWsStoreState, "revokedServerIds" | "channelAccessScopes">,
  scope: { serverId?: string | null; channelId?: string; parentChannelId?: string | null },
) {
  const channel = scope.channelId ? state.channelAccessScopes.get(scope.channelId) : undefined
  const serverId = scope.serverId ?? channel?.serverId
  const parentId = scope.parentChannelId ?? channel?.parentChannelId
  return !((serverId && state.revokedServerIds.has(serverId))
    || channel?.revoked || (parentId && state.channelAccessScopes.get(parentId)?.revoked))
}

export function createCommunityWsStore(viewerId: string | null, publishPresence?: (patches: ReadonlyMap<string, CommunityPresence>) => void) {
  let livePresenceByUserId = new Map<string, CommunityPresence>()
  let livePresenceRevisions = new Map<string, number>()
  let livePresenceRevision = 0
  let pendingChanged = new Map<string, CommunityPresence>()
  let presenceFlushScheduled = false
  let presenceFlushEpoch = 0

  const store = createStore(
    { ...initialState(), presenceByUserId: livePresenceByUserId, presenceRevisionsByUserId: livePresenceRevisions },
    ({ setState, get }): Omit<CommunityWsStoreState, keyof ReturnType<typeof initialState>> => {
  const commitPresenceNow = () => {
    presenceFlushScheduled = false
    const committedPresence = new Map(livePresenceByUserId)
    livePresenceByUserId = committedPresence
    const changed = pendingChanged
    pendingChanged = new Map()
    setState((state) => ({
      ...state,
      presenceRevision: livePresenceRevision,
      presenceByUserId: committedPresence,
      presenceRevisionsByUserId: livePresenceRevisions,
    }))
    if (changed.size > 0) publishPresence?.(changed)
  }

  const schedulePresenceFlush = () => {
    if (presenceFlushScheduled) return
    presenceFlushScheduled = true
    const scheduledEpoch = presenceFlushEpoch
    queueMicrotask(() => {
      if (scheduledEpoch !== presenceFlushEpoch || !presenceFlushScheduled) return
      commitPresenceNow()
    })
  }

  const writePresence = (
    snapshot: CommunityPresenceSnapshot,
    patches: ReadonlyMap<string, CommunityPresence> | readonly [string, CommunityPresence][],
    guardSnapshot: boolean,
    coalesce: boolean,
  ) => {
    const state = get()
    if (
      !snapshot.viewerId
      || snapshot.viewerId !== state.profileViewerId
      || snapshot.accountEpoch !== state.profileAccountEpoch
    ) return false
    const entries = patches instanceof Map ? patches.entries() : patches
    const nextRevision = livePresenceRevision + 1
    let presenceTouched = false
    let revisionTouched = false
    for (const [userId, presence] of entries) {
      const previousRevision = livePresenceRevisions.get(userId) ?? 0
      if (guardSnapshot && previousRevision > snapshot.revision) continue
      if (livePresenceByUserId.get(userId) !== presence) {
        livePresenceByUserId.set(userId, presence)
        pendingChanged.set(userId, presence)
        presenceTouched = true
      }
      if (!guardSnapshot) {
        livePresenceRevisions.set(userId, nextRevision)
        revisionTouched = true
      }
    }
    if (revisionTouched) livePresenceRevision = nextRevision
    if (presenceTouched || revisionTouched) {
      if (coalesce) schedulePresenceFlush()
      else commitPresenceNow()
    }
    return true
  }

  return {
    activateProfileAccount: (viewerId) => {
      const state = get()
      if (state.profileViewerId === viewerId) return state.profileAccountEpoch
      const profileAccountEpoch = state.profileAccountEpoch + 1
      presenceFlushEpoch += 1
      presenceFlushScheduled = false
      livePresenceRevision = 0
      livePresenceByUserId = new Map()
      livePresenceRevisions = new Map()
      pendingChanged = new Map()
      setState((state) => ({ ...state, ...{
        profileViewerId: viewerId,
        profileAccountEpoch,
        accessEpoch: state.accessEpoch + 1,
        channelAccessScopes: new Map(),
        serverAccessGenerations: new Map(),
        revokedServerIds: new Set(),
        presenceRevision: 0,
        presenceByUserId: livePresenceByUserId,
        presenceRevisionsByUserId: livePresenceRevisions,
      } }))
      return profileAccountEpoch
    },

    beginPresenceSnapshot: () => ({
      viewerId: get().profileViewerId,
      accountEpoch: get().profileAccountEpoch,
      revision: livePresenceRevision,
    }),

    seedPresence: (snapshot, patches) => writePresence(snapshot, patches, true, false),
    setPresence: (userId, presence) => writePresence(
      {
        viewerId: get().profileViewerId,
        accountEpoch: get().profileAccountEpoch,
        revision: livePresenceRevision,
      },
      [[userId, presence]],
      false,
      true,
    ),
    setPresenceBatch: (patches) => writePresence(
      {
        viewerId: get().profileViewerId,
        accountEpoch: get().profileAccountEpoch,
        revision: livePresenceRevision,
      },
      patches,
      false,
      false,
    ),
    forgetPresence: (userId) => {
      livePresenceRevision += 1
      livePresenceByUserId.delete(userId)
      pendingChanged.delete(userId)
      livePresenceRevisions.set(userId, livePresenceRevision)
      commitPresenceNow()
    },

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

  beginChannelMembershipChange: (serverId, channelId, options) => {
    const scopes = new Map(get().channelAccessScopes)
    const previous = scopes.get(channelId)
    const generation = (previous?.generation ?? 0) + 1
    const { denialCode, ...prior } = previous ?? {}
    scopes.set(channelId, { ...prior, serverId, revoked: !!options?.preserveRevocation && !!previous?.revoked, generation,
      ...(options?.preserveRevocation && previous?.revoked && denialCode ? { denialCode } : {}) })
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
      scopes.set(parentChannelId, { serverId: parent.serverId, parentChannelId: parent.parentChannelId, generation: parent.generation, revoked: false })
    }
    setState((state) => ({ ...state, ...{ channelAccessScopes: scopes } }))
  },

  revokeChannelAccess: (serverId, channelId, denialCode) => {
    const scopes = new Map(get().channelAccessScopes)
    const affected = new Set([channelId])
    for (const [id, scope] of scopes) {
      if (scope.serverId === serverId && scope.parentChannelId === channelId) affected.add(id)
    }
    for (const id of affected) {
      const previous = scopes.get(id)
      scopes.set(id, { serverId, ...previous, generation: (previous?.generation ?? 0) + (previous?.revoked ? 0 : 1), revoked: true,
        ...(denialCode ? { denialCode } : {}) })
    }
    setState((state) => ({ ...state, ...{ channelAccessScopes: scopes } }))
    return [...affected]
  },

  revokeServerAccess: (serverId) => {
    const revokedServerIds = new Set(get().revokedServerIds).add(serverId)
    const serverAccessGenerations = new Map(get().serverAccessGenerations)
    serverAccessGenerations.set(serverId, (serverAccessGenerations.get(serverId) ?? 0) + 1)
    setState((state) => ({ ...state, ...{ revokedServerIds, serverAccessGenerations, accessEpoch: get().accessEpoch + 1 } }))
  },

  grantServerAccess: (serverId) => {
    const revokedServerIds = new Set(get().revokedServerIds)
    revokedServerIds.delete(serverId)
    setState((state) => ({ ...state, ...{ revokedServerIds } }))
  },

  isChannelAccessRevoked: (channelId, serverId, parentChannelId) =>
    !communityScopeAllowsAccess(get(), { channelId, serverId, parentChannelId }),

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

    reset: () => {
      presenceFlushEpoch += 1
      presenceFlushScheduled = false
      livePresenceRevision = 0
      livePresenceByUserId = new Map()
      livePresenceRevisions = new Map()
      pendingChanged = new Map()
      setState((state) => ({ ...state, ...{
        ...initialState(),
        presenceByUserId: livePresenceByUserId,
        presenceRevisionsByUserId: livePresenceRevisions,
        profileAccountEpoch: get().profileAccountEpoch + 1,
      } }))
    },
  }
  })
  store.actions.activateProfileAccount(viewerId)
  return store
}
