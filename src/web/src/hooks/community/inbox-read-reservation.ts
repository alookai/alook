"use client"

import { communityKeys } from "@/lib/query-keys"
import type { QueryClient } from "@tanstack/react-query"

type InboxChild = {
  channelId: string
  lastMessageAt: string
  openerMessageId?: string
  openerSeq?: number
  openerUnread?: boolean
}

type InboxChannel = {
  channelId: string
  lastMessageAt: string
  hasDirectUnread?: boolean
  children: InboxChild[]
}

type InboxResponse = {
  servers: Array<{ channels: InboxChannel[] }>
  dms: Array<{ channelId: string; lastMessageAt: string }>
}

export type InboxReadCandidate = {
  channelId: string
  lastMessageAt: string
  fingerprint: string
  openerMessageId?: string
  openerSeq?: number
  openerUnread: boolean
}

export type InboxReadReservationLease = {
  queryClient: QueryClient
  token: symbol
  epoch: number
  channelId: string
}

export type ThreadOpenerRouteLease = {
  queryClient: QueryClient
  token: symbol
  nonce: string
  serverId: string
  childChannelId: string
}

export type ThreadOpenerHandoffTarget = {
  nonce: string
  serverId: string
  parentChannelId: string
  childChannelId: string
  openerMessageId: string
  openerSeq: number
}

type ThreadOpenerHandoff = ThreadOpenerHandoffTarget & {
  epoch: number
  phase: "armed" | "awaiting-opener-claim" | "claimed-parent-generation"
}

type ClaimedThreadOpener = ThreadOpenerHandoffTarget & {
  generation: number
}

type HeldResponse<T extends InboxResponse = InboxResponse> = {
  id: number
  candidate: InboxReadCandidate
  data: T
  generation: number | null
  openerClaimLocked: boolean
  reject: (error: unknown) => void
  removeAbort: () => void
}

type LeaseState = {
  lease: InboxReadReservationLease
  onCandidate: (candidate: InboxReadCandidate | null) => void
}

type ManagerState = {
  queryClient: QueryClient
  leases: Map<symbol, LeaseState>
  latestToken: symbol | null
  nextEpoch: number
  nextResponseId: number
  held: Map<number, HeldResponse>
  permit: { epoch: number; channelId: string; fingerprint: string | null } | null
  handoff: ThreadOpenerHandoff | null
  claimedOpeners: Map<number, ClaimedThreadOpener>
  routeLeases: Map<symbol, ThreadOpenerRouteLease>
  refetch: Promise<unknown> | null
  disposed: boolean
}

const managers = new WeakMap<QueryClient, ManagerState>()

function managerFor(queryClient: QueryClient) {
  let state = managers.get(queryClient)
  if (!state) {
    state = {
      queryClient,
      leases: new Map(),
      latestToken: null,
      nextEpoch: 0,
      nextResponseId: 0,
      held: new Map(),
      permit: null,
      handoff: null,
      claimedOpeners: new Map(),
      routeLeases: new Map(),
      refetch: null,
      disposed: false,
    }
    managers.set(queryClient, state)
  }
  return state
}

function fingerprint(candidate: Omit<InboxReadCandidate, "fingerprint">) {
  return JSON.stringify([
    candidate.channelId,
    candidate.lastMessageAt,
    candidate.openerMessageId ?? null,
    candidate.openerSeq ?? null,
    candidate.openerUnread,
  ])
}

function candidateFor(data: InboxResponse, channelId: string): InboxReadCandidate | null {
  for (const server of data.servers) {
    for (const channel of server.channels) {
      const child = channel.children.find((row) => row.channelId === channelId)
      if (child) {
        const candidate = {
          channelId,
          lastMessageAt: child.lastMessageAt,
          ...(child.openerMessageId ? { openerMessageId: child.openerMessageId } : {}),
          ...(child.openerSeq !== undefined ? { openerSeq: child.openerSeq } : {}),
          openerUnread: child.openerUnread === true,
        }
        return { ...candidate, fingerprint: fingerprint(candidate) }
      }
      if (channel.channelId === channelId && channel.hasDirectUnread !== false) {
        const candidate = {
          channelId,
          lastMessageAt: channel.lastMessageAt,
          openerUnread: false,
        }
        return { ...candidate, fingerprint: fingerprint(candidate) }
      }
    }
  }
  const dm = data.dms.find((row) => row.channelId === channelId)
  if (!dm) return null
  const candidate = {
    channelId,
    lastMessageAt: dm.lastMessageAt,
    openerUnread: false,
  }
  return { ...candidate, fingerprint: fingerprint(candidate) }
}

function activeLease(state: ManagerState) {
  return state.latestToken ? state.leases.get(state.latestToken) ?? null : null
}

function handoffMatches(
  handoff: ThreadOpenerHandoffTarget | null,
  candidate: InboxReadCandidate,
) {
  return !!handoff
    && handoff.childChannelId === candidate.channelId
    && handoff.openerMessageId === candidate.openerMessageId
    && handoff.openerSeq === candidate.openerSeq
    && candidate.openerUnread
}

function claimedOpenerForCandidate(
  state: ManagerState,
  candidate: InboxReadCandidate,
) {
  let match: ClaimedThreadOpener | null = null
  for (const claimed of state.claimedOpeners.values()) {
    if (handoffMatches(claimed, candidate)) match = claimed
  }
  return match
}

function hasExactRouteLease(
  state: ManagerState,
  handoff: ThreadOpenerHandoffTarget,
) {
  return [...state.routeLeases.values()].some((lease) => (
    lease.nonce === handoff.nonce
    && lease.serverId === handoff.serverId
    && lease.childChannelId === handoff.childChannelId
  ))
}

function shouldAwaitOpenerClaim(
  state: ManagerState,
  candidate: InboxReadCandidate,
) {
  const handoff = state.handoff
  return !!handoff
    && handoff.phase === "armed"
    && handoffMatches(handoff, candidate)
    && hasExactRouteLease(state, handoff)
}

function notifyActive(state: ManagerState, candidate: InboxReadCandidate | null) {
  activeLease(state)?.onCandidate(candidate)
}

function cancelHeld(state: ManagerState, held: HeldResponse) {
  if (!state.held.delete(held.id)) return
  held.removeAbort()
  held.reject(new DOMException("Inbox response superseded", "AbortError"))
}

function queueAuthoritativeRefetch(state: ManagerState) {
  if (state.disposed || state.refetch) return state.refetch ?? Promise.resolve()
  const queryKey = communityKeys.inboxUnreads()
  state.refetch = state.queryClient.cancelQueries({ queryKey, exact: true })
    .then(() => state.queryClient.refetchQueries({ queryKey, exact: true, type: "active" }))
    .finally(() => {
      state.refetch = null
    })
  return state.refetch
}

function releaseHeldNegative(state: ManagerState, held: HeldResponse) {
  const handoff = state.handoff
  if (
    handoff?.phase === "armed"
    && handoffMatches(handoff, held.candidate)
    && !hasExactRouteLease(state, handoff)
  ) {
    state.handoff = null
  }
  state.permit = {
    epoch: activeLease(state)?.lease.epoch ?? state.nextEpoch,
    channelId: held.candidate.channelId,
    fingerprint: held.candidate.fingerprint,
  }
  cancelHeld(state, held)
  notifyActive(state, null)
  return queueAuthoritativeRefetch(state)
}

function reclassifyHeld(state: ManagerState) {
  const lease = activeLease(state)
  if (!lease) return
  let latest: InboxReadCandidate | null = null
  for (const held of state.held.values()) {
    if (held.openerClaimLocked) continue
    const candidate = candidateFor(held.data, lease.lease.channelId)
    if (!candidate) {
      void releaseHeldNegative(state, held)
      continue
    }
    held.candidate = candidate
    const claimed = claimedOpenerForCandidate(state, candidate)
    held.generation = claimed?.generation ?? null
    held.openerClaimLocked = claimed !== null
    if (shouldAwaitOpenerClaim(state, candidate) && state.handoff) {
      state.handoff.phase = "awaiting-opener-claim"
    }
    latest = candidate
  }
  notifyActive(state, latest)
}

export function registerInboxReadReservationSurface(
  queryClient: QueryClient,
  channelId: string,
  onCandidate: (candidate: InboxReadCandidate | null) => void,
): InboxReadReservationLease {
  const state = managerFor(queryClient)
  const token = Symbol(channelId)
  const lease = {
    queryClient,
    token,
    epoch: ++state.nextEpoch,
    channelId,
  }
  state.leases.set(token, { lease, onCandidate })
  state.latestToken = token
  reclassifyHeld(state)
  return lease
}

export function releaseInboxReadReservationSurface(lease: InboxReadReservationLease) {
  const state = managers.get(lease.queryClient)
  if (!state || state.disposed) return
  state.leases.delete(lease.token)
  if (state.latestToken !== lease.token) return
  state.latestToken = null
  const epoch = ++state.nextEpoch
  queueMicrotask(() => {
    if (state.disposed || state.latestToken || state.nextEpoch !== epoch) return
    for (const held of [...state.held.values()]) void releaseHeldNegative(state, held)
  })
}

export function promoteInboxReadReservation(
  lease: InboxReadReservationLease,
  generation: number,
) {
  const state = managers.get(lease.queryClient)
  const current = state?.leases.get(lease.token)
  if (!state || !current || current.lease.epoch !== lease.epoch) return false
  for (const held of state.held.values()) {
    if (held.candidate.channelId === lease.channelId && !held.openerClaimLocked) {
      held.generation = generation
    }
  }
  return true
}

export function takeInboxReadReservationNegative(
  lease: InboxReadReservationLease,
) {
  const state = managers.get(lease.queryClient)
  const current = state?.leases.get(lease.token)
  if (!state || !current || current.lease.epoch !== lease.epoch) return false
  if (state.handoff?.phase === "awaiting-opener-claim") return false
  for (const held of [...state.held.values()]) {
    if (held.candidate.channelId === lease.channelId && held.generation === null) {
      void releaseHeldNegative(state, held)
    }
  }
  return true
}

export async function settleInboxReadReservationGeneration(
  queryClient: QueryClient,
  generation: number,
  committed: boolean,
  channelId: string,
) {
  const state = managers.get(queryClient)
  if (!state || state.disposed) return
  const claimed = state.claimedOpeners.get(generation) ?? null
  const matching = [...state.held.values()].filter((held) => held.generation === generation)
  if (!committed) {
    state.claimedOpeners.delete(generation)
    if (matching.length === 0) {
      const lease = activeLease(state)
      const permitChannelId = claimed?.childChannelId ?? channelId
      if (lease?.lease.channelId !== permitChannelId) return
      state.permit = {
        epoch: lease.lease.epoch,
        channelId: permitChannelId,
        fingerprint: null,
      }
      notifyActive(state, null)
      await queueAuthoritativeRefetch(state)
      return
    }
    await Promise.all(matching.map((held) => releaseHeldNegative(state, held)))
    return
  }
  if (matching.length === 0 && !claimed) return
  await state.queryClient.cancelQueries({
    queryKey: communityKeys.inboxUnreads(),
    exact: true,
  })
  state.claimedOpeners.delete(generation)
  for (const held of [...state.held.values()]) {
    if (held.generation === generation) cancelHeld(state, held)
  }
  notifyActive(state, null)
}

export async function reserveInboxUnreadsResponse<T extends InboxResponse>(
  queryClient: QueryClient,
  data: T,
  signal?: AbortSignal,
): Promise<T> {
  const state = managerFor(queryClient)
  const lease = activeLease(state)
  if (state.disposed || !lease) return data
  const candidate = candidateFor(data, lease.lease.channelId)
  if (!candidate) return data
  const claimed = claimedOpenerForCandidate(state, candidate)
  if (
    !claimed
    && state.permit
    && state.permit.epoch === lease.lease.epoch
    && state.permit.channelId === candidate.channelId
    && (
      state.permit.fingerprint === null
      || state.permit.fingerprint === candidate.fingerprint
    )
  ) {
    state.permit = null
    return data
  }
  if (signal?.aborted) throw new DOMException("Inbox response aborted", "AbortError")
  return new Promise<T>((_resolve, reject) => {
    const id = ++state.nextResponseId
    const onAbort = () => {
      const held = state.held.get(id)
      if (!held) return
      state.held.delete(id)
      held.removeAbort()
      reject(new DOMException("Inbox response aborted", "AbortError"))
    }
    signal?.addEventListener("abort", onAbort, { once: true })
    const held: HeldResponse<T> = {
      id,
      candidate,
      data,
      generation: claimed?.generation ?? null,
      openerClaimLocked: claimed !== null,
      reject,
      removeAbort: () => signal?.removeEventListener("abort", onAbort),
    }
    state.held.set(id, held)
    if (shouldAwaitOpenerClaim(state, candidate) && state.handoff) {
      state.handoff.phase = "awaiting-opener-claim"
    }
    lease.onCandidate(candidate)
  })
}

export function armThreadOpenerReservationHandoff(
  queryClient: QueryClient,
  target: ThreadOpenerHandoffTarget,
) {
  const state = managerFor(queryClient)
  if (state.handoff) terminateThreadOpenerReservationHandoff(queryClient, state.handoff.nonce)
  state.handoff = {
    ...target,
    epoch: ++state.nextEpoch,
    phase: "armed",
  }
}

export function getThreadOpenerReservationHandoff(
  queryClient: QueryClient,
  nonce: string,
) {
  const handoff = managerFor(queryClient).handoff
  return handoff?.nonce === nonce ? { ...handoff } : null
}

export function registerThreadOpenerRouteLease(
  queryClient: QueryClient,
  nonce: string,
  serverId: string,
  childChannelId: string,
): ThreadOpenerRouteLease {
  const state = managerFor(queryClient)
  const lease = {
    queryClient,
    token: Symbol(`${serverId}/${childChannelId}`),
    nonce,
    serverId,
    childChannelId,
  }
  state.routeLeases.set(lease.token, lease)
  const handoff = state.handoff
  if (
    handoff?.phase === "armed"
    && hasExactRouteLease(state, handoff)
    && [...state.held.values()].some((held) => handoffMatches(handoff, held.candidate))
  ) {
    handoff.phase = "awaiting-opener-claim"
  }
  return lease
}

export function releaseThreadOpenerRouteLease(lease: ThreadOpenerRouteLease) {
  const state = managers.get(lease.queryClient)
  if (!state || state.disposed || !state.routeLeases.delete(lease.token)) return
  queueMicrotask(() => {
    if (state.disposed) return
    const replaced = [...state.routeLeases.values()].some((candidate) => (
      candidate.nonce === lease.nonce
      && candidate.serverId === lease.serverId
      && candidate.childChannelId === lease.childChannelId
    ))
    if (replaced) return
    const handoff = state.handoff
    if (
      handoff?.nonce === lease.nonce
      && handoff.serverId === lease.serverId
      && handoff.childChannelId === lease.childChannelId
    ) {
      terminateThreadOpenerReservationHandoff(lease.queryClient, lease.nonce)
    }
  })
}

export function completeThreadOpenerReservationHandoff(
  queryClient: QueryClient,
  nonce: string,
  generation: number,
) {
  const state = managerFor(queryClient)
  const handoff = state.handoff
  if (!handoff || handoff.nonce !== nonce) return false
  handoff.phase = "claimed-parent-generation"
  for (const held of state.held.values()) {
    if (handoffMatches(handoff, held.candidate)) {
      held.generation = generation
      held.openerClaimLocked = true
    }
  }
  state.claimedOpeners.set(generation, { ...handoff, generation })
  state.handoff = null
  return true
}

export function terminateThreadOpenerReservationHandoff(
  queryClient: QueryClient,
  nonce: string,
) {
  const state = managerFor(queryClient)
  const handoff = state.handoff
  if (!handoff || handoff.nonce !== nonce) return false
  const matching = [...state.held.values()].filter((held) => handoffMatches(handoff, held.candidate))
  state.handoff = null
  for (const held of matching) void releaseHeldNegative(state, held)
  if (matching.length === 0) void queueAuthoritativeRefetch(state)
  return true
}

export function clearThreadOpenerReservationHandoff(queryClient: QueryClient) {
  const handoff = managerFor(queryClient).handoff
  return handoff
    ? terminateThreadOpenerReservationHandoff(queryClient, handoff.nonce)
    : false
}

export function disposeInboxReadReservation(queryClient: QueryClient) {
  const state = managers.get(queryClient)
  if (!state || state.disposed) return
  state.disposed = true
  state.handoff = null
  state.claimedOpeners.clear()
  state.routeLeases.clear()
  state.permit = null
  state.leases.clear()
  state.latestToken = null
  for (const held of [...state.held.values()]) cancelHeld(state, held)
  managers.delete(queryClient)
}
