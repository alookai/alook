import type { Server } from "./models/navigation"
import { ApiError } from "@/lib/errors"
import { communityServerId } from "./community-route"
import {
  COMMUNITY_COLD_ENTRY_FALLBACK,
  consumeCommunityColdEntryFailure,
} from "./last-community-route"

// Module-scoped marker set. The "Leave" button in the server rail marks
// the server id here BEFORE firing the mutation; the layout's eject effect
// consumes it — if present, the leave was voluntary and the button owns
// the toast, so the layout stays silent. Any other trigger (kick, server
// delete, forbidden URL) finds no marker and shows the involuntary toast.
//
// Set-backed, not a ref, because the button and the layout live in
// sibling subtrees and threading a context just for this is heavier than
// the coordination warrants. Same trick as `wsStore.hasSeenMessage`.
const voluntaryLeaves = new Set<string>()

export type OwnerServerDeleteRouteToken = object

type OwnerServerDeleteRecord = {
  serverId: string
  request: "pending" | "resolving" | "navigating"
  originToken: OwnerServerDeleteRouteToken
  participantTokens: Set<OwnerServerDeleteRouteToken>
  lastCommittedHref: string
  targetHref: string | null
  navigationIssued: boolean
  scopes: "retained" | "flushing"
}

type OwnerServerDeleteState = {
  transactions: Map<string, OwnerServerDeleteRecord>
  tombstones: WeakMap<OwnerServerDeleteRouteToken, string>
  flushedServerIds: Set<string>
}

type OwnerServerDeleteWindow = Window & {
  __alookOwnerServerDeleteStateV8?: OwnerServerDeleteState
}

const ownerServerDeleteFallback: OwnerServerDeleteState = {
  transactions: new Map(),
  tombstones: new WeakMap(),
  flushedServerIds: new Set(),
}

function ownerServerDeleteState(): OwnerServerDeleteState {
  if (typeof window === "undefined") return ownerServerDeleteFallback
  const scope = window as OwnerServerDeleteWindow
  scope.__alookOwnerServerDeleteStateV8 ??= {
    transactions: new Map(),
    tombstones: new WeakMap(),
    flushedServerIds: new Set(),
  }
  return scope.__alookOwnerServerDeleteStateV8
}

function ownerServerDeleteScopeFlushReady(record: OwnerServerDeleteRecord): boolean {
  return record.request !== "pending"
    && communityServerId(record.lastCommittedHref) !== record.serverId
    && record.scopes === "retained"
}

export function markVoluntaryLeave(serverId: string): void {
  voluntaryLeaves.add(serverId)
}

// Returns true iff the id was marked; clears the marker either way.
export function consumeVoluntaryLeave(serverId: string): boolean {
  return voluntaryLeaves.delete(serverId)
}

export function createOwnerServerDeleteRouteToken(): OwnerServerDeleteRouteToken {
  return {}
}

export function registerOwnerServerDeleteRoute(
  serverId: string,
  token: OwnerServerDeleteRouteToken,
): "participant" | "ordinary" {
  const state = ownerServerDeleteState()
  const record = state.transactions.get(serverId)
  if (record?.scopes === "retained") {
    record.participantTokens.add(token)
    return "participant"
  }
  if (state.tombstones.get(token) === serverId) state.tombstones.delete(token)
  return "ordinary"
}

export function beginOwnerServerDelete(
  serverId: string,
  originToken: OwnerServerDeleteRouteToken,
): void {
  const state = ownerServerDeleteState()
  const current = state.transactions.get(serverId)
  if (current) {
    if (current.scopes === "retained") current.participantTokens.add(originToken)
    return
  }
  state.flushedServerIds.delete(serverId)
  state.transactions.set(serverId, {
    serverId,
    request: "pending",
    originToken,
    participantTokens: new Set([originToken]),
    lastCommittedHref: `/c/channels/${encodeURIComponent(serverId)}`,
    targetHref: null,
    navigationIssued: false,
    scopes: "retained",
  })
}

export function commitOwnerServerDelete(
  serverId: string,
  originToken: OwnerServerDeleteRouteToken,
): boolean {
  const record = ownerServerDeleteState().transactions.get(serverId)
  if (!record || record.originToken !== originToken || record.request !== "pending") return false
  record.request = "resolving"
  return ownerServerDeleteScopeFlushReady(record)
}

export function cancelOwnerServerDelete(
  serverId: string,
  originToken?: OwnerServerDeleteRouteToken,
): void {
  const state = ownerServerDeleteState()
  const record = state.transactions.get(serverId)
  if (record && (!originToken || record.originToken === originToken)) {
    state.transactions.delete(serverId)
  }
}

export function claimOwnerServerDeleteNavigation(
  serverId: string,
  originToken: OwnerServerDeleteRouteToken,
  targetHref: string,
): boolean {
  const record = ownerServerDeleteState().transactions.get(serverId)
  if (!record
    || record.originToken !== originToken
    || record.request !== "resolving"
    || record.scopes !== "retained"
    || record.navigationIssued
    || communityServerId(record.lastCommittedHref) !== serverId
    || communityServerId(targetHref) === serverId) return false
  record.request = "navigating"
  record.targetHref = targetHref
  record.navigationIssued = true
  return true
}

export function isOwnerServerDeleteRouteProtected(
  serverId: string,
  token?: OwnerServerDeleteRouteToken,
): boolean {
  const state = ownerServerDeleteState()
  if (state.transactions.has(serverId)) return true
  return token ? state.tombstones.get(token) === serverId : false
}

export function isOwnerServerDeleteScopeEvictionBlocked(serverId: string): boolean {
  const state = ownerServerDeleteState()
  return state.transactions.has(serverId) || state.flushedServerIds.has(serverId)
}

export function isOwnerServerDeleteCompleted(serverId: string): boolean {
  return ownerServerDeleteState().flushedServerIds.has(serverId)
}

export function observeOwnerServerDeleteRouteCommit(committedHref: string): string[] {
  const state = ownerServerDeleteState()
  for (const record of state.transactions.values()) {
    record.lastCommittedHref = committedHref
  }
  return ownerServerDeleteScopeFlushCandidates()
}

export function ownerServerDeleteScopeFlushCandidates(): string[] {
  return [...ownerServerDeleteState().transactions]
    .filter(([, record]) => ownerServerDeleteScopeFlushReady(record))
    .map(([serverId]) => serverId)
}

export function isOwnerServerDeleteScopeFlushReady(serverId: string): boolean {
  const record = ownerServerDeleteState().transactions.get(serverId)
  return record ? ownerServerDeleteScopeFlushReady(record) : false
}

export function claimOwnerServerDeleteScopeFlush(serverId: string): boolean {
  const record = ownerServerDeleteState().transactions.get(serverId)
  if (!record || !ownerServerDeleteScopeFlushReady(record)) return false
  record.scopes = "flushing"
  return true
}

export function completeOwnerServerDeleteScopeFlush(serverId: string): boolean {
  const state = ownerServerDeleteState()
  const record = state.transactions.get(serverId)
  if (!record || record.scopes !== "flushing") return false
  for (const token of record.participantTokens) state.tombstones.set(token, serverId)
  state.flushedServerIds.add(serverId)
  state.transactions.delete(serverId)
  return true
}

export function isDefinitiveChildMetaFailure(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 403 || error.status === 404)
}

// Pure destination picker for the post-eject redirect. When the viewer
// has any other servers, the first (railOrder-sorted from the API) wins.
// Otherwise the DM home is the only safe landing spot.
export function pickPostEjectDestination(
  servers: readonly Server[],
  ejectedServerId: string,
  serverDestination?: (serverId: string) => string,
): string {
  const remaining = servers.filter((s) => s.id !== ejectedServerId)
  if (remaining.length === 0) return "/c/me"
  return serverDestination?.(remaining[0].id) ?? `/c/channels/${remaining[0].id}`
}

export function runAuthoritativeServerEject(args: {
  serverId: string
  servers: readonly Server[]
  isSuccess: boolean
  isFetching: boolean
  ownerDeleteRouteProtected?: boolean
  consumeVoluntaryLeave: (serverId: string) => boolean
  clearLastChannel: (serverId: string) => void
  toast: (message: string) => void
  replace: (destination: string) => void
  accountId?: string
  routeHref?: string
}): boolean {
  // Absence is authoritative only on a settled successful snapshot. A first
  // failure has isFetched=true in TanStack, and a failed background refetch can
  // retain last-good data; neither may become an existence/membership verdict.
  if (!args.isSuccess || args.isFetching) return false
  if (args.servers.some((server) => server.id === args.serverId)) return false
  if (args.ownerDeleteRouteProtected) return false
  args.clearLastChannel(args.serverId)
  const voluntary = args.consumeVoluntaryLeave(args.serverId)
  if (!voluntary) args.toast("You're no longer in this server")
  const coldEntryFailure = args.accountId && args.routeHref
    ? consumeCommunityColdEntryFailure(args.accountId, args.routeHref)
    : false
  args.replace(coldEntryFailure
    ? COMMUNITY_COLD_ENTRY_FALLBACK
    : pickPostEjectDestination(args.servers, args.serverId))
  return true
}
