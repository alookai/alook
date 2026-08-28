"use client"

import { communityKeys } from "@/lib/query-keys"
import type { Mention, UnreadDm, UnreadServer } from "@/lib/community/models/inbox"
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

export type InboxRowTarget =
  | {
      kind: "channel-direct"
      identity: string
      fingerprint: string
      confirmationChannelId: string
      serverId: string
      channelId: string
    }
  | {
      kind: "thread"
      identity: string
      fingerprint: string
      confirmationChannelId: string
      serverId: string
      parentChannelId: string
      childChannelId: string
    }
  | {
      kind: "dm"
      identity: string
      fingerprint: string
      confirmationChannelId: string
      channelId: string
    }
  | {
      kind: "mention"
      identity: string
      fingerprint: string
      confirmationChannelId: string
      mentionId: string
    }

export type InboxProjectionTerminalReceipt = {
  epoch: number
  target: InboxRowTarget
  terminal: "success" | "negative" | "deferred" | "error"
  disposition: "retire" | "rollback"
  observedFingerprint: string | null
}

export type InboxProjectionTicket = {
  queryClient: QueryClient
  token: symbol
  epoch: number
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

type FocusedCandidate = {
  epoch: number
  candidate: InboxReadCandidate
  generation: number | null
}

type ResponsePermit = {
  epoch: number
  channelId: string
  lastMessageAt: string | null
  fingerprint: string | null
}

type ManagerState = {
  queryClient: QueryClient
  leases: Map<symbol, LeaseState>
  latestToken: symbol | null
  nextEpoch: number
  nextResponseId: number
  held: Map<number, HeldResponse>
  focusedCandidate: FocusedCandidate | null
  discardedCandidate: { epoch: number; candidate: InboxReadCandidate } | null
  permit: ResponsePermit | null
  handoff: ThreadOpenerHandoff | null
  claimedOpeners: Map<number, ClaimedThreadOpener>
  routeLeases: Map<symbol, ThreadOpenerRouteLease>
  refetch: Promise<unknown> | null
  projectionTickets: Map<symbol, ProjectionTicketState>
  projectionCandidates: Map<number, InboxReadCandidate>
  projectionTerminals: Map<number, ProjectionTerminalState>
  disposed: boolean
}

type ProjectionTicketState = {
  ticket: InboxProjectionTicket
  target: InboxRowTarget
  active: boolean
  generation: number | null
  onReceipt: (receipt: InboxProjectionTerminalReceipt) => void
}

type ProjectionTerminalState = {
  terminal: InboxProjectionTerminalReceipt["terminal"]
  candidate: InboxReadCandidate | null
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
      focusedCandidate: null,
      discardedCandidate: null,
      permit: null,
      handoff: null,
      claimedOpeners: new Map(),
      routeLeases: new Map(),
      refetch: null,
      projectionTickets: new Map(),
      projectionCandidates: new Map(),
      projectionTerminals: new Map(),
      disposed: false,
    }
    managers.set(queryClient, state)
  }
  return state
}

export function inboxReadCandidateFingerprint(
  candidate: Omit<InboxReadCandidate, "fingerprint">,
) {
  return JSON.stringify([
    candidate.channelId,
    candidate.lastMessageAt,
    candidate.openerMessageId ?? null,
    candidate.openerSeq ?? null,
    candidate.openerUnread,
  ])
}

function inboxMentionFingerprint(mention: Mention) {
  return JSON.stringify([mention.id, mention.m.id, mention.m.seq ?? null])
}

export function inboxChannelRowTarget(
  server: UnreadServer,
  channel: UnreadServer["channels"][number],
): InboxRowTarget | null {
  if (channel.hasDirectUnread === false) return null
  return {
    kind: "channel-direct",
    identity: JSON.stringify(["channel-direct", server.serverId, channel.channelId]),
    fingerprint: inboxReadCandidateFingerprint({
      channelId: channel.channelId,
      lastMessageAt: channel.lastMessageAt,
      openerUnread: false,
    }),
    confirmationChannelId: channel.channelId,
    serverId: server.serverId,
    channelId: channel.channelId,
  }
}

export function inboxThreadRowTarget(
  server: UnreadServer,
  parent: UnreadServer["channels"][number],
  child: UnreadServer["channels"][number]["children"][number],
): InboxRowTarget {
  const parentChannelId = child.parentChannelId ?? parent.channelId
  return {
    kind: "thread",
    identity: JSON.stringify([
      "thread",
      server.serverId,
      parentChannelId,
      child.channelId,
    ]),
    fingerprint: inboxReadCandidateFingerprint({
      channelId: child.channelId,
      lastMessageAt: child.lastMessageAt,
      ...(child.openerMessageId ? { openerMessageId: child.openerMessageId } : {}),
      ...(child.openerSeq !== undefined ? { openerSeq: child.openerSeq } : {}),
      openerUnread: child.openerUnread === true,
    }),
    confirmationChannelId: child.openerUnread === true && child.openerSeq !== undefined
      ? parentChannelId
      : child.channelId,
    serverId: server.serverId,
    parentChannelId,
    childChannelId: child.channelId,
  }
}

export function inboxDmRowTarget(dm: UnreadDm): InboxRowTarget {
  return {
    kind: "dm",
    identity: JSON.stringify(["dm", dm.channelId]),
    fingerprint: inboxReadCandidateFingerprint({
      channelId: dm.channelId,
      lastMessageAt: dm.lastMessageAt,
      openerUnread: false,
    }),
    confirmationChannelId: dm.channelId,
    channelId: dm.channelId,
  }
}

export function inboxMentionRowTarget(mention: Mention): InboxRowTarget | null {
  if (!mention.serverId || !mention.channelId) return null
  return {
    kind: "mention",
    identity: JSON.stringify(["mention", mention.id]),
    fingerprint: inboxMentionFingerprint(mention),
    confirmationChannelId: mention.channelId,
    mentionId: mention.id,
  }
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
        return { ...candidate, fingerprint: inboxReadCandidateFingerprint(candidate) }
      }
      if (channel.channelId === channelId && channel.hasDirectUnread !== false) {
        const candidate = {
          channelId,
          lastMessageAt: channel.lastMessageAt,
          openerUnread: false,
        }
        return { ...candidate, fingerprint: inboxReadCandidateFingerprint(candidate) }
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
  return { ...candidate, fingerprint: inboxReadCandidateFingerprint(candidate) }
}

function targetMatchesCandidate(
  target: InboxRowTarget,
  candidate: InboxReadCandidate,
) {
  if (target.kind === "mention") {
    return target.confirmationChannelId === candidate.channelId
  }
  const channelId = target.kind === "thread"
    ? target.childChannelId
    : target.channelId
  return channelId === candidate.channelId && target.fingerprint === candidate.fingerprint
}

function observedProjectionFingerprint(
  queryClient: QueryClient,
  target: InboxRowTarget,
) {
  if (target.kind === "mention") {
    const data = queryClient.getQueryData<{ mentions: Mention[] }>(
      communityKeys.inboxMentions(),
    )
    const mention = data?.mentions.find((row) => row.id === target.mentionId)
    return mention ? inboxMentionFingerprint(mention) : null
  }
  const data = queryClient.getQueryData<InboxResponse>(communityKeys.inboxUnreads())
  if (!data) return null
  if (target.kind === "dm") {
    const dm = data.dms.find((row) => row.channelId === target.channelId)
    return dm ? inboxDmRowTarget(dm as UnreadDm).fingerprint : null
  }
  const server = data.servers.find((row) => (
    "serverId" in row && row.serverId === target.serverId
  )) as UnreadServer | undefined
  if (!server) return null
  if (target.kind === "channel-direct") {
    const channel = server.channels.find((row) => row.channelId === target.channelId)
    return channel ? inboxChannelRowTarget(server, channel)?.fingerprint ?? null : null
  }
  const parent = server.channels.find((row) => row.channelId === target.parentChannelId)
  const child = parent?.children.find((row) => row.channelId === target.childChannelId)
  return parent && child ? inboxThreadRowTarget(server, parent, child).fingerprint : null
}

function freezeProjectionReceipt(
  state: ManagerState,
  ticket: ProjectionTicketState,
  terminal: InboxProjectionTerminalReceipt["terminal"],
) {
  const observedFingerprint = terminal === "deferred"
    || terminal === "error"
    || (terminal === "negative" && ticket.target.kind === "mention")
    ? null
    : observedProjectionFingerprint(state.queryClient, ticket.target)
  const disposition = terminal === "deferred"
    || terminal === "error"
    || (terminal === "negative" && ticket.target.kind === "mention")
    || observedFingerprint === ticket.target.fingerprint
    ? "rollback"
    : "retire"
  return {
    epoch: ticket.ticket.epoch,
    target: ticket.target,
    terminal,
    disposition,
    observedFingerprint,
  } satisfies InboxProjectionTerminalReceipt
}

function deliverProjectionTerminal(
  state: ManagerState,
  ticket: ProjectionTicketState,
  terminal: InboxProjectionTerminalReceipt["terminal"],
) {
  if (!ticket.active || !state.projectionTickets.delete(ticket.ticket.token)) return
  ticket.onReceipt(freezeProjectionReceipt(state, ticket, terminal))
}

function bindProjectionTickets(
  state: ManagerState,
  candidate: InboxReadCandidate,
  generation: number | null,
) {
  for (const ticket of state.projectionTickets.values()) {
    if (!targetMatchesCandidate(ticket.target, candidate)) continue
    if (generation !== null) ticket.generation = generation
    const terminal = generation === null
      ? null
      : state.projectionTerminals.get(generation)?.terminal ?? null
    if (terminal) deliverProjectionTerminal(state, ticket, terminal)
  }
}

function rememberProjectionCandidate(
  state: ManagerState,
  generation: number,
  candidate: InboxReadCandidate,
) {
  state.projectionCandidates.set(generation, candidate)
  while (state.projectionCandidates.size > 32) {
    const oldest = state.projectionCandidates.keys().next().value
    if (oldest === undefined) break
    state.projectionCandidates.delete(oldest)
  }
  bindProjectionTickets(state, candidate, generation)
}

function publishProjectionTerminal(
  state: ManagerState,
  generation: number,
  terminal: InboxProjectionTerminalReceipt["terminal"],
) {
  const candidate = state.projectionCandidates.get(generation) ?? null
  state.projectionTerminals.set(generation, { terminal, candidate })
  while (state.projectionTerminals.size > 32) {
    const oldest = state.projectionTerminals.keys().next().value
    if (oldest === undefined) break
    state.projectionTerminals.delete(oldest)
  }
  for (const ticket of [...state.projectionTickets.values()]) {
    if (ticket.generation === generation) {
      deliverProjectionTerminal(state, ticket, terminal)
    }
  }
}

function publishProjectionCandidateTerminal(
  state: ManagerState,
  candidate: InboxReadCandidate,
  terminal: "negative" | "error",
) {
  const generations = new Set<number>()
  for (const ticket of [...state.projectionTickets.values()]) {
    if (!targetMatchesCandidate(ticket.target, candidate)) continue
    if (ticket.generation !== null) generations.add(ticket.generation)
    else deliverProjectionTerminal(state, ticket, terminal)
  }
  for (const generation of generations) {
    publishProjectionTerminal(state, generation, terminal)
  }
}

function publishProjectionHandoffTerminal(
  state: ManagerState,
  handoff: ThreadOpenerHandoffTarget,
  terminal: "negative" | "error",
) {
  for (const ticket of [...state.projectionTickets.values()]) {
    const target = ticket.target
    if (
      target.kind === "thread"
      && target.serverId === handoff.serverId
      && target.parentChannelId === handoff.parentChannelId
      && target.childChannelId === handoff.childChannelId
    ) {
      deliverProjectionTerminal(state, ticket, terminal)
    }
  }
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

function candidateIdentityMatches(
  expected: InboxReadCandidate,
  actual: InboxReadCandidate,
) {
  return expected.channelId === actual.channelId
    && expected.lastMessageAt === actual.lastMessageAt
    && (
      expected.openerMessageId === undefined
      || actual.openerMessageId === undefined
      || expected.openerMessageId === actual.openerMessageId
    )
    && (
      expected.openerSeq === undefined
      || actual.openerSeq === undefined
      || expected.openerSeq === actual.openerSeq
    )
}

function permitMatches(
  permit: ResponsePermit,
  epoch: number,
  candidate: InboxReadCandidate,
) {
  return permit.epoch === epoch
    && permit.channelId === candidate.channelId
    && (permit.lastMessageAt === null || permit.lastMessageAt === candidate.lastMessageAt)
    && (permit.fingerprint === null || permit.fingerprint === candidate.fingerprint)
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
    lastMessageAt: held.candidate.lastMessageAt,
    fingerprint: held.candidate.fingerprint,
  }
  cancelHeld(state, held)
  notifyActive(state, null)
  return queueAuthoritativeRefetch(state).then(
    () => publishProjectionCandidateTerminal(state, held.candidate, "negative"),
    () => {
      publishProjectionCandidateTerminal(state, held.candidate, "error")
    },
  )
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
    bindProjectionTickets(state, candidate, held.generation)
    latest = candidate
  }
  notifyActive(state, latest)
}

export function registerInboxProjectionTicket(
  queryClient: QueryClient,
  epoch: number,
  target: InboxRowTarget,
  onReceipt: (receipt: InboxProjectionTerminalReceipt) => void,
): InboxProjectionTicket {
  const state = managerFor(queryClient)
  const ticket = { queryClient, token: Symbol(target.identity), epoch }
  const ticketState: ProjectionTicketState = {
    ticket,
    target,
    active: false,
    generation: null,
    onReceipt,
  }
  state.projectionTickets.set(ticket.token, ticketState)
  const focused = state.focusedCandidate
  if (focused && targetMatchesCandidate(target, focused.candidate)) {
    ticketState.generation = focused.generation
  }
  if (ticketState.generation === null) {
    const generations = [...state.projectionCandidates.entries()].reverse()
    const match = generations.find(([, candidate]) => targetMatchesCandidate(target, candidate))
    if (match) ticketState.generation = match[0]
  }
  return ticket
}

export function activateInboxProjectionTicket(ticket: InboxProjectionTicket) {
  const state = managers.get(ticket.queryClient)
  const current = state?.projectionTickets.get(ticket.token)
  if (!state || !current || current.ticket.epoch !== ticket.epoch) return false
  current.active = true
  const terminal = current.generation === null
    ? null
    : state.projectionTerminals.get(current.generation)?.terminal ?? null
  if (terminal) deliverProjectionTerminal(state, current, terminal)
  return true
}

export function cancelInboxProjectionTicket(ticket: InboxProjectionTicket) {
  const state = managers.get(ticket.queryClient)
  return state?.projectionTickets.delete(ticket.token) ?? false
}

export function publishInboxProjectionGenerationTerminal(
  queryClient: QueryClient,
  generation: number,
  terminal: "success" | "deferred" | "error",
) {
  const state = managers.get(queryClient)
  if (!state || state.disposed) return
  publishProjectionTerminal(state, generation, terminal)
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
  if (state.focusedCandidate?.epoch !== lease.epoch) state.focusedCandidate = null
  reclassifyHeld(state)
  return lease
}

export function armInboxReadReservationCandidate(
  queryClient: QueryClient,
  input: {
    channelId: string
    lastMessageAt: string
    openerMessageId?: string
    openerSeq?: number
  },
) {
  const state = managerFor(queryClient)
  const lease = activeLease(state)
  if (state.disposed || !lease || lease.lease.channelId !== input.channelId) return false
  const candidateBase = {
    channelId: input.channelId,
    lastMessageAt: input.lastMessageAt,
    ...(input.openerMessageId ? { openerMessageId: input.openerMessageId } : {}),
    ...(input.openerSeq !== undefined ? { openerSeq: input.openerSeq } : {}),
    openerUnread: false,
  }
  const candidate = {
    ...candidateBase,
    fingerprint: inboxReadCandidateFingerprint(candidateBase),
  }
  const current = state.focusedCandidate
  if (
    current?.epoch === lease.lease.epoch
    && candidateIdentityMatches(current.candidate, candidate)
  ) return false

  if (current?.epoch === lease.lease.epoch) {
    for (const held of [...state.held.values()]) {
      if (candidateIdentityMatches(current.candidate, held.candidate)) cancelHeld(state, held)
    }
  }
  if (
    state.permit?.epoch === lease.lease.epoch
    && state.permit.channelId === input.channelId
  ) {
    state.permit = null
  }
  if (
    state.discardedCandidate?.epoch === lease.lease.epoch
    && state.discardedCandidate.candidate.channelId === input.channelId
  ) {
    state.discardedCandidate = null
  }
  state.focusedCandidate = {
    epoch: lease.lease.epoch,
    candidate,
    generation: null,
  }
  bindProjectionTickets(state, candidate, null)
  notifyActive(state, candidate)
  return true
}

export function releaseInboxReadReservationSurface(lease: InboxReadReservationLease) {
  const state = managers.get(lease.queryClient)
  if (!state || state.disposed) return
  state.leases.delete(lease.token)
  if (state.latestToken !== lease.token) return
  state.latestToken = null
  if (state.focusedCandidate?.epoch === lease.epoch) state.focusedCandidate = null
  if (state.discardedCandidate?.epoch === lease.epoch) state.discardedCandidate = null
  if (state.permit?.epoch === lease.epoch) state.permit = null
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
  if (
    state.focusedCandidate?.epoch === lease.epoch
    && state.focusedCandidate.candidate.channelId === lease.channelId
  ) {
    state.focusedCandidate.generation = generation
    rememberProjectionCandidate(
      state,
      generation,
      state.focusedCandidate.candidate,
    )
  }
  for (const held of state.held.values()) {
    if (held.candidate.channelId === lease.channelId && !held.openerClaimLocked) {
      held.generation = generation
      rememberProjectionCandidate(state, generation, held.candidate)
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
  let released = false
  for (const held of [...state.held.values()]) {
    if (held.candidate.channelId === lease.channelId && held.generation === null) {
      released = true
      void releaseHeldNegative(state, held)
    }
  }
  const focused = state.focusedCandidate
  if (
    focused?.epoch === lease.epoch
    && focused.candidate.channelId === lease.channelId
    && focused.generation === null
  ) {
    state.focusedCandidate = null
    if (!released) {
      state.permit = {
        epoch: lease.epoch,
        channelId: focused.candidate.channelId,
        lastMessageAt: focused.candidate.lastMessageAt,
        fingerprint: null,
      }
      notifyActive(state, null)
      void queueAuthoritativeRefetch(state).then(
        () => publishProjectionCandidateTerminal(state, focused.candidate, "negative"),
        () => publishProjectionCandidateTerminal(state, focused.candidate, "error"),
      )
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
        lastMessageAt: state.focusedCandidate?.generation === generation
          ? state.focusedCandidate.candidate.lastMessageAt
          : null,
        fingerprint: null,
      }
      if (state.focusedCandidate?.generation === generation) {
        state.focusedCandidate = null
      }
      notifyActive(state, null)
      try {
        await queueAuthoritativeRefetch(state)
        const candidate = state.projectionCandidates.get(generation)
        if (candidate) publishProjectionTerminal(state, generation, "negative")
      } catch {
        publishProjectionTerminal(state, generation, "error")
      }
      return
    }
    await Promise.all(matching.map((held) => releaseHeldNegative(state, held)))
    publishProjectionTerminal(state, generation, "negative")
    if (state.focusedCandidate?.generation === generation) state.focusedCandidate = null
    return
  }
  if (matching.length === 0 && !claimed) {
    const focused = state.focusedCandidate
    if (committed && focused?.generation === generation) {
      state.discardedCandidate = {
        epoch: focused.epoch,
        candidate: focused.candidate,
      }
      state.focusedCandidate = null
      notifyActive(state, null)
    }
    return
  }
  await state.queryClient.cancelQueries({
    queryKey: communityKeys.inboxUnreads(),
    exact: true,
  })
  state.claimedOpeners.delete(generation)
  for (const held of [...state.held.values()]) {
    if (held.generation === generation) cancelHeld(state, held)
  }
  if (state.focusedCandidate?.generation === generation) state.focusedCandidate = null
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
  const armed = state.focusedCandidate?.epoch === lease.lease.epoch
    && state.focusedCandidate.candidate.channelId === candidate.channelId
    ? state.focusedCandidate
    : null
  let focused = armed && candidateIdentityMatches(armed.candidate, candidate)
    ? armed
    : null
  if (armed && !focused) {
    if (candidate.lastMessageAt <= armed.candidate.lastMessageAt) {
      throw new DOMException("Inbox response superseded", "AbortError")
    }
    for (const held of [...state.held.values()]) {
      if (candidateIdentityMatches(armed.candidate, held.candidate)) cancelHeld(state, held)
    }
    focused = {
      epoch: armed.epoch,
      candidate,
      generation: null,
    }
    state.focusedCandidate = focused
  }
  if (
    state.discardedCandidate?.epoch === lease.lease.epoch
    && candidateIdentityMatches(state.discardedCandidate.candidate, candidate)
  ) {
    throw new DOMException("Inbox response superseded", "AbortError")
  }
  if (
    !claimed
    && state.permit
    && permitMatches(state.permit, lease.lease.epoch, candidate)
  ) {
    state.permit = null
    if (focused) state.focusedCandidate = null
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
      generation: claimed?.generation ?? focused?.generation ?? null,
      openerClaimLocked: claimed !== null,
      reject,
      removeAbort: () => signal?.removeEventListener("abort", onAbort),
    }
    state.held.set(id, held)
    if (focused) {
      focused.candidate = candidate
    }
    if (shouldAwaitOpenerClaim(state, candidate) && state.handoff) {
      state.handoff.phase = "awaiting-opener-claim"
    }
    bindProjectionTickets(state, candidate, held.generation)
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
      rememberProjectionCandidate(state, generation, held.candidate)
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
  if (matching.length === 0) {
    void queueAuthoritativeRefetch(state).then(
      () => publishProjectionHandoffTerminal(state, handoff, "negative"),
      () => publishProjectionHandoffTerminal(state, handoff, "error"),
    )
  }
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
  state.focusedCandidate = null
  state.discardedCandidate = null
  state.permit = null
  state.leases.clear()
  state.latestToken = null
  state.projectionTickets.clear()
  state.projectionCandidates.clear()
  state.projectionTerminals.clear()
  for (const held of [...state.held.values()]) cancelHeld(state, held)
  managers.delete(queryClient)
}
