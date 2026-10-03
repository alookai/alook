import type { Server } from "./models/navigation"
import { ApiError } from "@/lib/errors"
import { communityServerId } from "./community-route"
import type { QueryClient } from "@tanstack/react-query"
import { createStore, type Store } from "@tanstack/store"
import { getCommunityDbRegistry } from "@/lib/community-db/collections"
import {
  COMMUNITY_COLD_ENTRY_FALLBACK,
  consumeCommunityColdEntryFailure,
} from "./last-community-route"

export type OwnerServerDeleteRouteToken = { owner: QueryClient; store: Store<OwnerServerDeleteState> }

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

export type OwnerServerDeleteState = {
  transactions: Map<string, OwnerServerDeleteRecord>
  tombstones: WeakMap<OwnerServerDeleteRouteToken, string>
  flushedServerIds: Set<string>
  voluntaryLeaves: Set<string>
  meRootLanding: boolean
}

export function emptyOwnerServerDeleteState(): OwnerServerDeleteState {
  return { transactions: new Map(), tombstones: new WeakMap(), flushedServerIds: new Set(), voluntaryLeaves: new Set(), meRootLanding: false }
}

export function createOwnerServerDeleteStore(): Store<OwnerServerDeleteState> {
  return createStore(emptyOwnerServerDeleteState())
}

function ownerServerDeleteStore(queryClient: QueryClient, token?: OwnerServerDeleteRouteToken) {
  if (token) return token.owner === queryClient ? token.store : undefined
  return getCommunityDbRegistry(queryClient)?.runtime.serverEject
}

function changeOwnerServerDelete<T>(queryClient: QueryClient, change: (state: OwnerServerDeleteState) => T, token?: OwnerServerDeleteRouteToken): T | undefined {
  const store = ownerServerDeleteStore(queryClient, token)
  if (!store) return undefined
  let result!: T
  store.setState((previous) => {
    const state = { ...previous, transactions: new Map(previous.transactions), flushedServerIds: new Set(previous.flushedServerIds), voluntaryLeaves: new Set(previous.voluntaryLeaves) }
    result = change(state)
    return state
  })
  return result
}

export function isOwnerServerDeleteMeRootLanding(queryClient: QueryClient): boolean {
  return ownerServerDeleteStore(queryClient)?.get().meRootLanding ?? false
}

function ownerServerDeleteScopeFlushReady(record: OwnerServerDeleteRecord): boolean {
  return record.request !== "pending"
    && communityServerId(record.lastCommittedHref) !== record.serverId
    && record.scopes === "retained"
}

export function markVoluntaryLeave(queryClient: QueryClient, serverId: string): void {
  changeOwnerServerDelete(queryClient, (state) => { state.voluntaryLeaves.add(serverId) })
}

export function consumeVoluntaryLeave(queryClient: QueryClient, serverId: string): boolean {
  return changeOwnerServerDelete(queryClient, (state) => state.voluntaryLeaves.delete(serverId)) ?? false
}

export function createOwnerServerDeleteRouteToken(queryClient: QueryClient): OwnerServerDeleteRouteToken {
  const store = ownerServerDeleteStore(queryClient)
  if (!store) throw new DOMException("Missing delete route owner", "AbortError")
  return { owner: queryClient, store }
}

export function registerOwnerServerDeleteRoute(queryClient: QueryClient, serverId: string, token: OwnerServerDeleteRouteToken): "participant" | "ordinary" {
  return changeOwnerServerDelete(queryClient, (state) => {
    const record = state.transactions.get(serverId)
    if (record?.scopes === "retained") {
      state.transactions.set(serverId, { ...record, participantTokens: new Set([...record.participantTokens, token]) })
      return "participant" as const
    }
    if (state.tombstones.get(token) === serverId) state.tombstones.delete(token)
    return "ordinary" as const
  }, token) ?? "ordinary"
}

export function beginOwnerServerDelete(queryClient: QueryClient, serverId: string, originToken: OwnerServerDeleteRouteToken): void {
  changeOwnerServerDelete(queryClient, (state) => {
    const current = state.transactions.get(serverId)
    if (current) {
      if (current.scopes === "retained") state.transactions.set(serverId, { ...current, participantTokens: new Set([...current.participantTokens, originToken]) })
      return
    }
    state.meRootLanding = false
    state.flushedServerIds.delete(serverId)
    state.transactions.set(serverId, {
      serverId, request: "pending", originToken, participantTokens: new Set([originToken]),
      lastCommittedHref: `/c/channels/${encodeURIComponent(serverId)}`, targetHref: null,
      navigationIssued: false, scopes: "retained",
    })
  }, originToken)
}

export function commitOwnerServerDelete(queryClient: QueryClient, serverId: string, originToken: OwnerServerDeleteRouteToken): boolean {
  return changeOwnerServerDelete(queryClient, (state) => {
    const record = state.transactions.get(serverId)
    if (!record || record.originToken !== originToken || record.request !== "pending") return false
    const next = { ...record, request: "resolving" as const }
    state.transactions.set(serverId, next)
    return ownerServerDeleteScopeFlushReady(next)
  }, originToken) ?? false
}

export function cancelOwnerServerDelete(queryClient: QueryClient, serverId: string, originToken?: OwnerServerDeleteRouteToken): void {
  changeOwnerServerDelete(queryClient, (state) => {
    const record = state.transactions.get(serverId)
    if (record && (!originToken || record.originToken === originToken)) state.transactions.delete(serverId)
  }, originToken)
}

export function claimOwnerServerDeleteNavigation(queryClient: QueryClient, serverId: string, originToken: OwnerServerDeleteRouteToken, targetHref: string): boolean {
  return changeOwnerServerDelete(queryClient, (state) => {
    const record = state.transactions.get(serverId)
    if (!record || record.originToken !== originToken || record.request !== "resolving" || record.scopes !== "retained" || record.navigationIssued || communityServerId(record.lastCommittedHref) !== serverId || communityServerId(targetHref) === serverId) return false
    state.transactions.set(serverId, { ...record, request: "navigating", targetHref, navigationIssued: true })
    state.meRootLanding = targetHref === "/c/me"
    return true
  }, originToken) ?? false
}

export function isOwnerServerDeleteRouteProtected(queryClient: QueryClient, serverId: string, token?: OwnerServerDeleteRouteToken): boolean {
  const state = ownerServerDeleteStore(queryClient, token)?.get()
  return !!state && (state.transactions.has(serverId) || !!token && state.tombstones.get(token) === serverId)
}

export function isOwnerServerDeleteScopeEvictionBlocked(queryClient: QueryClient, serverId: string): boolean {
  const state = ownerServerDeleteStore(queryClient)?.get()
  return !!state && (state.transactions.has(serverId) || state.flushedServerIds.has(serverId))
}

export function isOwnerServerDeleteCompleted(queryClient: QueryClient, serverId: string): boolean {
  return ownerServerDeleteStore(queryClient)?.get().flushedServerIds.has(serverId) ?? false
}

export function observeOwnerServerDeleteRouteCommit(queryClient: QueryClient, committedHref: string): string[] {
  changeOwnerServerDelete(queryClient, (state) => {
    if (committedHref !== "/c/me") state.meRootLanding = false
    for (const [id, record] of state.transactions) state.transactions.set(id, { ...record, lastCommittedHref: committedHref })
  })
  return ownerServerDeleteScopeFlushCandidates(queryClient)
}

export function ownerServerDeleteScopeFlushCandidates(queryClient: QueryClient): string[] {
  return [...(ownerServerDeleteStore(queryClient)?.get().transactions ?? [])].filter(([, record]) => ownerServerDeleteScopeFlushReady(record)).map(([serverId]) => serverId)
}

export function isOwnerServerDeleteScopeFlushReady(queryClient: QueryClient, serverId: string): boolean {
  const record = ownerServerDeleteStore(queryClient)?.get().transactions.get(serverId)
  return record ? ownerServerDeleteScopeFlushReady(record) : false
}

export function claimOwnerServerDeleteScopeFlush(queryClient: QueryClient, serverId: string): boolean {
  return changeOwnerServerDelete(queryClient, (state) => {
    const record = state.transactions.get(serverId)
    if (!record || !ownerServerDeleteScopeFlushReady(record)) return false
    state.transactions.set(serverId, { ...record, scopes: "flushing" })
    return true
  }) ?? false
}

export function completeOwnerServerDeleteScopeFlush(queryClient: QueryClient, serverId: string): boolean {
  return changeOwnerServerDelete(queryClient, (state) => {
    const record = state.transactions.get(serverId)
    if (!record || record.scopes !== "flushing") return false
    for (const token of record.participantTokens) state.tombstones.set(token, serverId)
    state.flushedServerIds.add(serverId)
    state.transactions.delete(serverId)
    return true
  }) ?? false
}

export function isDefinitiveChildMetaFailure(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 403 || error.status === 404)
}

// Pure destination picker for the post-eject redirect. When the viewer
// has any other servers, the first (railOrder-sorted from the API) wins.
// Otherwise the DM home is the only safe landing spot.
export function pickPostEjectDestination(
  servers: readonly Pick<Server, "id">[],
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
