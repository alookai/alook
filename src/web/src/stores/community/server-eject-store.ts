import { createStore, type Store } from "@tanstack/store"
import type { QueryClient } from "@tanstack/react-query"

export type OwnerServerDeleteRouteToken = { owner: QueryClient; store: Store<OwnerServerDeleteState> }

export type OwnerServerDeleteRecord = {
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
