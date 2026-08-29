"use client"

import { create } from "zustand"
import type {
  CommunityProfile,
  CommunityProfilePatch,
  CommunityProfileSnapshot,
} from "@/lib/community/models/people"

/**
 * Zustand store for community WS-live-patched state.
 *
 * Owned exclusively by the WS handler (`hooks/community/use-community-ws.ts`)
 * after Step 4 lands; consumers read via the selector hooks below. Kept
 * separate from `useCommunityStore` so subscription re-renders only fire on
 * the axis that changed — a presence tick doesn't re-render a component that
 * only cares about the current channel id.
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
  kind: "cli_invocation" | "tool_call" | "thinking" | "wake_trigger" | "session_reset" | "nap" | "model_changed" | "provider_changed" | "error"
  payload: unknown
  sessionId?: string | null
  launchId?: string | null
  createdAt: string
}

type ProfileRevisions = { identityAbout: number; status: number; presence: number }
type ProfileWriteMode = "seed" | "patch" | "commit"
export type CommunityWsConnectionStatus = "connected" | "reconnecting" | "failed"

const NOOP_RECONNECT = () => undefined

export type CommunityWsStoreState = {
  accessEpoch: number
  accessConnected: boolean
  connectionStatus: CommunityWsConnectionStatus
  reconnectNow: () => void
  profileViewerId: string | null
  profileAccountEpoch: number
  profileRevision: number
  profilesByUserId: Map<string, CommunityProfile>
  profileRevisionsByUserId: Map<string, ProfileRevisions>
  seenMessageIds: Set<string>
  seenDeliveryOperations: Map<string, DeliveryOperationState>
  /**
   * Per-bot rings of recent audit events, each bounded by BOT_AUDIT_RING_MAX.
   * Newest first inside each bot's array. A chatty bot never evicts a quieter
   * bot's events. Absent-bot lookup returns an empty array.
   */
  botAuditEvents: Map<string, BotAuditEventEntry[]>

  activateProfileAccount: (viewerId: string | null) => number
  beginProfileSnapshot: () => CommunityProfileSnapshot
  seedProfiles: (
    snapshot: CommunityProfileSnapshot,
    patches: readonly CommunityProfilePatch[],
  ) => boolean
  commitProfiles: (
    snapshot: CommunityProfileSnapshot,
    patches: readonly CommunityProfilePatch[],
  ) => boolean
  patchProfiles: (
    snapshot: Pick<CommunityProfileSnapshot, "viewerId" | "accountEpoch">,
    patches: readonly CommunityProfilePatch[],
  ) => boolean
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
  "profileViewerId" | "profileAccountEpoch" | "profileRevision"
  | "profilesByUserId" | "profileRevisionsByUserId"
  | "seenMessageIds" | "seenDeliveryOperations" | "botAuditEvents"
  | "accessEpoch" | "accessConnected"
  | "connectionStatus" | "reconnectNow"
> => ({
  accessEpoch: 0,
  accessConnected: false,
  connectionStatus: "connected",
  reconnectNow: NOOP_RECONNECT,
  profileViewerId: null,
  profileAccountEpoch: 0,
  profileRevision: 0,
  profilesByUserId: new Map(),
  profileRevisionsByUserId: new Map(),
  seenMessageIds: new Set(),
  seenDeliveryOperations: new Map(),
  botAuditEvents: new Map(),
})

const ZERO_REVISIONS: ProfileRevisions = { identityAbout: 0, status: 0, presence: 0 }

function mergeIdentityAbout(
  profile: CommunityProfile,
  patch: CommunityProfilePatch["identityAbout"],
) {
  if (!patch) return profile
  return { ...profile, ...patch }
}

function mergeAvatar(profile: CommunityProfile, patch: CommunityProfilePatch["avatar"]) {
  if (!patch || !Number.isSafeInteger(patch.avatarVersion) || patch.avatarVersion < 0) {
    return profile
  }
  if (profile.avatarVersion !== undefined && patch.avatarVersion <= profile.avatarVersion) {
    return profile
  }
  return { ...profile, ...patch }
}

function profileChanged(previous: CommunityProfile, next: CommunityProfile) {
  const keys = new Set([...Object.keys(previous), ...Object.keys(next)])
  for (const key of keys) {
    if (previous[key as keyof CommunityProfile] !== next[key as keyof CommunityProfile]) return true
  }
  return false
}

export const useCommunityWsStore = create<CommunityWsStoreState>((set, get) => {
  const writeProfiles = (
    snapshot: CommunityProfileSnapshot,
    patches: readonly CommunityProfilePatch[],
    mode: ProfileWriteMode,
  ) => {
    const state = get()
    if (
      !snapshot.viewerId
      || snapshot.viewerId !== state.profileViewerId
      || snapshot.accountEpoch !== state.profileAccountEpoch
    ) return false
    const revision = state.profileRevision + 1
    const guardsRevision = mode !== "patch"
    const advancesRevisionForGroups = mode !== "seed"
    let profiles: Map<string, CommunityProfile> | null = null
    let revisions: Map<string, ProfileRevisions> | null = null
    let advancesRevision = false
    for (const patch of patches) {
      const previous = (profiles ?? state.profilesByUserId).get(patch.id) ?? { id: patch.id }
      const previousRevisions = (revisions ?? state.profileRevisionsByUserId)
        .get(patch.id) ?? ZERO_REVISIONS
      let next = previous
      const identityAbout = patch.identityAbout !== undefined
        && (!guardsRevision || previousRevisions.identityAbout <= snapshot.revision)
      const status = patch.status !== undefined
        && (!guardsRevision || previousRevisions.status <= snapshot.revision)
      const presence = patch.presence !== undefined
        && (!guardsRevision || previousRevisions.presence <= snapshot.revision)
      if (identityAbout) next = mergeIdentityAbout(next, patch.identityAbout)
      next = mergeAvatar(next, patch.avatar)
      if (status) next = { ...next, ...patch.status }
      if (presence) next = { ...next, presence: patch.presence }
      if (profileChanged(previous, next)) {
        profiles ??= new Map(state.profilesByUserId)
        profiles.set(patch.id, next)
      }
      if (advancesRevisionForGroups && (identityAbout || status || presence)) {
        advancesRevision = true
        revisions ??= new Map(state.profileRevisionsByUserId)
        revisions.set(patch.id, {
          identityAbout: identityAbout ? revision : previousRevisions.identityAbout,
          status: status ? revision : previousRevisions.status,
          presence: presence ? revision : previousRevisions.presence,
        })
      }
    }
    if (profiles || advancesRevision) {
      set({
        ...(profiles ? { profilesByUserId: profiles } : {}),
        ...(advancesRevision ? {
          profileRevision: revision,
          profileRevisionsByUserId: revisions!,
        } : {}),
      })
    }
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
        profileRevision: 0,
        profilesByUserId: new Map(),
        profileRevisionsByUserId: new Map(),
      })
      return profileAccountEpoch
    },

    beginProfileSnapshot: () => ({
      viewerId: get().profileViewerId,
      accountEpoch: get().profileAccountEpoch,
      revision: get().profileRevision,
    }),

    seedProfiles: (snapshot, patches) => writeProfiles(snapshot, patches, "seed"),
    commitProfiles: (snapshot, patches) => writeProfiles(snapshot, patches, "commit"),
    patchProfiles: (snapshot, patches) => writeProfiles(
      { ...snapshot, revision: get().profileRevision },
      patches,
      "patch",
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

  markAccessDisconnected: () => set((state) => ({
    accessEpoch: state.accessEpoch + 1,
    accessConnected: false,
  })),

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

// ── Selectors ────────────────────────────────────────────────────────────────

export function useCommunityProfile(userId: string | null | undefined) {
  return useCommunityWsStore((state) =>
    userId ? state.profilesByUserId.get(userId) : undefined,
  )
}

export function useProfilesByUserId(): ReadonlyMap<string, CommunityProfile> {
  return useCommunityWsStore((state) => state.profilesByUserId)
}

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
