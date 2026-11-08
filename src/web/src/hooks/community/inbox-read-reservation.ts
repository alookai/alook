"use client"

import { createStore } from "@tanstack/react-store"
import { captureCommunityLiveSnapshotToken, assertCommunityLiveSnapshotTokenCurrent, getCanonicalCommunityAttentionScopes, getCanonicalCommunityAttentionItems, getCanonicalCommunityChannels, getCanonicalCommunityMessages } from "@/lib/community-db/sync"
import { communityKeys } from "@/lib/query-keys"
import type { Mention, UnreadDm, UnreadServer } from "@/lib/community/models/inbox"
import type { QueryClient } from "@tanstack/react-query"
import {
  getCommunityDbRegistry,
  type CommunityDbRegistry,
} from "@/lib/community-db/collections"
import {
  clearAttentionScopeOptimistically,
  commitAttentionOptimisticSnapshot,
  hasAttentionScopeOptimisticFence,
  restoreAttentionOptimisticSnapshot,
  type AttentionScopeOptimisticSnapshot,
} from "@/lib/community-db/sync"
import { reconcileAccountAttention } from "./use-account-attention"

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
      reservedThroughSeq?: number
    }
  | {
      kind: "thread"
      identity: string
      fingerprint: string
      confirmationChannelId: string
      serverId: string
      parentChannelId: string
      childChannelId: string
      reservedThroughSeq?: number
    }
  | {
      kind: "dm"
      identity: string
      fingerprint: string
      confirmationChannelId: string
      channelId: string
      reservedThroughSeq?: number
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

type ThreadOpenerHandoff = ThreadOpenerHandoffTarget & { projectionTickets: readonly InboxProjectionTicket[] }

type ClaimedThreadOpener = ThreadOpenerHandoffTarget & {
  generation: number
}

type LeaseState = {
  lease: InboxReadReservationLease
  onCandidate: (candidate: InboxReadCandidate | null) => void
}

type FocusedCandidate = {
  epoch: number
  candidate: InboxReadCandidate
  generation: number | null
  attentionOptimistic: CanonicalAttentionOptimistic | null
}

type ManagerData = {
  queryClient: QueryClient
  leases: ReadonlyMap<symbol, LeaseState>
  latestToken: symbol | null
  nextEpoch: number
  focusedCandidate: FocusedCandidate | null
  handoff: ThreadOpenerHandoff | null
  claimedOpeners: ReadonlyMap<number, ClaimedThreadOpener>
  routeLeases: ReadonlyMap<symbol, ThreadOpenerRouteLease>
  refetch: Promise<unknown> | null
  projectionTickets: ReadonlyMap<symbol, ProjectionTicketState>
  projectionCandidates: ReadonlyMap<number, InboxReadCandidate>
  projectionTerminals: ReadonlyMap<number, ProjectionTerminalState>
  disposed: boolean
}

type ProjectionTicketState = {
  ticket: InboxProjectionTicket
  target: InboxRowTarget
  active: boolean
  pendingTerminal: InboxProjectionTerminalReceipt["terminal"] | null
  generation: number | null
  onReceipt: (receipt: InboxProjectionTerminalReceipt) => void
  attentionOptimistic: CanonicalAttentionOptimistic | null
}

type CanonicalAttentionOptimistic = {
  registry: CommunityDbRegistry
  snapshot: AttentionScopeOptimisticSnapshot
}

type ProjectionTerminalState = {
  terminal: InboxProjectionTerminalReceipt["terminal"]
}

class ManagerState {
  readonly store
  readonly origin
  constructor(queryClient: QueryClient) {
    this.store = createStore<ManagerData>({
      queryClient,
      leases: new Map(),
      latestToken: null,
      nextEpoch: 0,
      focusedCandidate: null,
      handoff: null,
      claimedOpeners: new Map(),
      routeLeases: new Map(),
      refetch: null,
      projectionTickets: new Map(),
      projectionCandidates: new Map(),
      projectionTerminals: new Map(),
      disposed: false,
    })
    this.origin = captureCommunityLiveSnapshotToken(queryClient)
  }
  assertActive() { if (this.disposed) throw new DOMException("Retired inbox reservation", "AbortError"); assertCommunityLiveSnapshotTokenCurrent(this.queryClient, this.origin, undefined) }
  changeMap<K extends ManagerMapField>(field: K, update: (map: Map<ManagerMapKey<K>, ManagerMapValue<K>>) => void) {
    this.store.setState((state) => { const map = new Map(state[field] as ReadonlyMap<ManagerMapKey<K>, ManagerMapValue<K>>); update(map); return { ...state, [field]: map } })
  }
  get queryClient() { return this.store.get().queryClient }
  get leases() { return this.store.get().leases }
  set leases(value: ManagerData["leases"]) { this.store.setState((state) => state.leases === value ? state : { ...state, leases: value }) }
  get latestToken() { return this.store.get().latestToken }
  set latestToken(value: ManagerData["latestToken"]) { this.store.setState((state) => state.latestToken === value ? state : { ...state, latestToken: value }) }
  get nextEpoch() { return this.store.get().nextEpoch }
  set nextEpoch(value: ManagerData["nextEpoch"]) { this.store.setState((state) => state.nextEpoch === value ? state : { ...state, nextEpoch: value }) }
  get focusedCandidate() { return this.store.get().focusedCandidate }
  set focusedCandidate(value: ManagerData["focusedCandidate"]) { this.store.setState((state) => state.focusedCandidate === value ? state : { ...state, focusedCandidate: value }) }
  get handoff() { return this.store.get().handoff }
  set handoff(value: ManagerData["handoff"]) { this.store.setState((state) => state.handoff === value ? state : { ...state, handoff: value }) }
  get claimedOpeners() { return this.store.get().claimedOpeners }
  set claimedOpeners(value: ManagerData["claimedOpeners"]) { this.store.setState((state) => state.claimedOpeners === value ? state : { ...state, claimedOpeners: value }) }
  get routeLeases() { return this.store.get().routeLeases }
  set routeLeases(value: ManagerData["routeLeases"]) { this.store.setState((state) => state.routeLeases === value ? state : { ...state, routeLeases: value }) }
  get refetch() { return this.store.get().refetch }
  set refetch(value: ManagerData["refetch"]) { this.store.setState((state) => state.refetch === value ? state : { ...state, refetch: value }) }
  get projectionTickets() { return this.store.get().projectionTickets }
  set projectionTickets(value: ManagerData["projectionTickets"]) { this.store.setState((state) => state.projectionTickets === value ? state : { ...state, projectionTickets: value }) }
  get projectionCandidates() { return this.store.get().projectionCandidates }
  set projectionCandidates(value: ManagerData["projectionCandidates"]) { this.store.setState((state) => state.projectionCandidates === value ? state : { ...state, projectionCandidates: value }) }
  get projectionTerminals() { return this.store.get().projectionTerminals }
  set projectionTerminals(value: ManagerData["projectionTerminals"]) { this.store.setState((state) => state.projectionTerminals === value ? state : { ...state, projectionTerminals: value }) }
  get disposed() { return this.store.get().disposed }
  set disposed(value: ManagerData["disposed"]) { this.store.setState((state) => state.disposed === value ? state : { ...state, disposed: value }) }
}
type ManagerMapField = { [K in keyof ManagerData]: ManagerData[K] extends ReadonlyMap<unknown, unknown> ? K : never }[keyof ManagerData]
type ManagerMapKey<K extends ManagerMapField> = ManagerData[K] extends ReadonlyMap<infer Key, unknown> ? Key : never
type ManagerMapValue<K extends ManagerMapField> = ManagerData[K] extends ReadonlyMap<unknown, infer Value> ? Value : never
function setManagerMap<K extends ManagerMapField>(state: ManagerState, field: K, key: ManagerMapKey<K>, value: ManagerMapValue<K>) { state.changeMap(field, (map) => { map.set(key, value) }) }
function deleteManagerMap<K extends ManagerMapField>(state: ManagerState, field: K, key: ManagerMapKey<K>) { const present = (state[field] as ReadonlyMap<ManagerMapKey<K>, ManagerMapValue<K>>).has(key); if (present) state.changeMap(field, (map) => { map.delete(key) }); return present }
function clearManagerMap<K extends ManagerMapField>(state: ManagerState, field: K) { if (state[field].size > 0) state.changeMap(field, (map) => { map.clear() }) }
const managers = new WeakMap<QueryClient, ManagerState>()
function managerFor(queryClient: QueryClient) { let state = managers.get(queryClient); if (!state) { state = new ManagerState(queryClient); managers.set(queryClient, state) } return state }
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
    ...(channel.lastUnreadSeq !== undefined
      ? { reservedThroughSeq: channel.lastUnreadSeq }
      : {}),
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
    ...(child.lastUnreadSeq !== undefined
      ? { reservedThroughSeq: child.lastUnreadSeq }
      : {}),
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
    ...(dm.lastUnreadSeq !== undefined ? { reservedThroughSeq: dm.lastUnreadSeq } : {}),
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

function observedProjectionFingerprint(queryClient: QueryClient, target: InboxRowTarget) {
  const scopes = new Map(getCanonicalCommunityAttentionScopes(queryClient).map((scope) => [scope.scopeId, scope]))
  const items = getCanonicalCommunityAttentionItems(queryClient)
  const channels = new Map(getCanonicalCommunityChannels(queryClient).map((channel) => [channel.id, channel]))
  const messages = new Map(getCanonicalCommunityMessages(queryClient).map((message) => [message.id, message]))
  if (target.kind === "mention") {
    const item = items.find((row) => row.sourceId === target.mentionId && (row.kind === "mention" || row.kind === "reply"))
    const message = item?.messageId ? messages.get(item.messageId) : undefined
    return item && message ? JSON.stringify([item.sourceId, message.id, message.seq ?? null]) : null
  }
  const channelId = target.kind === "thread" ? target.childChannelId : target.channelId
  const channel = channels.get(channelId), scope = scopes.get(channelId)
  if (!channel) return null
  if (target.kind === "thread") {
    const opener = items.find((item) => item.kind === "forum_post" && item.scopeId === target.parentChannelId && item.childChannelId === channelId && item.openerSeq !== undefined)
    const message = opener?.messageId ? messages.get(opener.messageId) : undefined
    if (opener && message) return inboxReadCandidateFingerprint({
      channelId, lastMessageAt: message.createdAt ?? channel.lastMessageAt ?? "",
      openerMessageId: message.id, openerSeq: opener.openerSeq, openerUnread: true,
    })
  }
  if (!scope || (!scope.ordinaryUnread && scope.attentionCount <= 0)) return null
  if (target.kind !== "dm" && scope.serverId !== target.serverId) return null
  if (target.kind === "channel-direct" && scope.attentionCount === 0 && items.some((item) => item.kind === "forum_post" && item.scopeId === channelId)) return null
  return inboxReadCandidateFingerprint({
    channelId, lastMessageAt: channel.lastMessageAt ?? "",
    ...(target.kind === "thread" ? {
      ...(channel.parentMessageId ? { openerMessageId: channel.parentMessageId } : {}),
      ...(channel.openerSeq !== undefined ? { openerSeq: channel.openerSeq } : {}),
      openerUnread: channel.openerUnread === true,
    } : { openerUnread: false }),
  })
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
  if (state.projectionTickets.get(ticket.ticket.token) !== ticket) return
  if (!ticket.active) {
    setManagerMap(state, "projectionTickets", ticket.ticket.token, { ...ticket, pendingTerminal: terminal })
    return
  }
  if (!deleteManagerMap(state, "projectionTickets", ticket.ticket.token)) return
  const settled = settleProjectionAttention(ticket, terminal === "success" || terminal === "deferred")
  void Promise.resolve(settled).then(() => {
    try { state.assertActive() } catch { return }
    if (managers.get(state.queryClient) !== state) return
    ticket.onReceipt(freezeProjectionReceipt(state, ticket, terminal))
  }).catch(() => undefined)
}

function projectionAttentionTarget(target: InboxRowTarget) {
  if (target.kind === "mention" || target.reservedThroughSeq === undefined) return null
  return {
    scopeId: target.kind === "thread" ? target.childChannelId : target.channelId,
    targetSeq: target.reservedThroughSeq,
  }
}

function beginProjectionAttention(ticket: ProjectionTicketState) {
  if (ticket.attentionOptimistic) return ticket
  const target = projectionAttentionTarget(ticket.target)
  if (!target) return ticket
  const registry = getCommunityDbRegistry(ticket.ticket.queryClient)
  if (
    !registry
    || hasAttentionScopeOptimisticFence(
      ticket.ticket.queryClient,
      target.scopeId,
      target.targetSeq,
    )
  ) return ticket
  return { ...ticket, attentionOptimistic: {
    registry,
    snapshot: clearAttentionScopeOptimistically(
      registry,
      target.scopeId,
      target.targetSeq,
    ),
  } }
}

function settleProjectionAttention(ticket: ProjectionTicketState, committed: boolean) {
  const optimistic = ticket.attentionOptimistic
  if (!optimistic) return
  const state = managers.get(ticket.ticket.queryClient)
  if (state?.projectionTickets.get(ticket.ticket.token) === ticket) setManagerMap(state, "projectionTickets", ticket.ticket.token, { ...ticket, attentionOptimistic: null })
  return settleCanonicalAttention(ticket.ticket.queryClient, optimistic, committed)
}

function settleCanonicalAttention(
  queryClient: QueryClient,
  optimistic: CanonicalAttentionOptimistic,
  committed: boolean,
) {
  if (committed) {
    return commitAttentionOptimisticSnapshot(optimistic.registry, optimistic.snapshot)
  }
  if (!restoreAttentionOptimisticSnapshot(optimistic.registry, optimistic.snapshot)) {
    const registry = getCommunityDbRegistry(queryClient)
    if (registry === optimistic.registry) {
      void reconcileAccountAttention(registry).catch(() => undefined)
    }
  }
}

function settleFocusedAttention(
  queryClient: QueryClient,
  focused: FocusedCandidate | null,
  committed: boolean,
) {
  const optimistic = focused?.attentionOptimistic
  if (!optimistic) return
  const state = managers.get(queryClient)
  if (state?.focusedCandidate === focused) state.focusedCandidate = { ...focused, attentionOptimistic: null }
  return settleCanonicalAttention(queryClient, optimistic, committed)
}

function bindProjectionTickets(
  state: ManagerState,
  candidate: InboxReadCandidate,
  generation: number | null,
) {
  for (const ticket of state.projectionTickets.values()) {
    if (!targetMatchesCandidate(ticket.target, candidate)) continue
    const current = generation !== null ? { ...ticket, generation, pendingTerminal: ticket.generation === generation ? ticket.pendingTerminal : null } : ticket
    if (generation !== null) setManagerMap(state, "projectionTickets", ticket.ticket.token, current)
    const terminal = generation === null
      ? null
      : state.projectionTerminals.get(generation)?.terminal ?? null
    if (terminal) deliverProjectionTerminal(state, current, terminal)
  }
}

function rememberProjectionCandidate(
  state: ManagerState,
  generation: number,
  candidate: InboxReadCandidate,
) {
  setManagerMap(state, "projectionCandidates", generation, candidate)
  while (state.projectionCandidates.size > 32) {
    const oldest = state.projectionCandidates.keys().next().value
    if (oldest === undefined) break
    deleteManagerMap(state, "projectionCandidates", oldest)
  }
  bindProjectionTickets(state, candidate, generation)
}

function publishProjectionTerminal(
  state: ManagerState,
  generation: number,
  terminal: InboxProjectionTerminalReceipt["terminal"],
) {
  setManagerMap(state, "projectionTerminals", generation, { terminal })
  while (state.projectionTerminals.size > 32) {
    const oldest = state.projectionTerminals.keys().next().value
    if (oldest === undefined) break
    deleteManagerMap(state, "projectionTerminals", oldest)
  }
  for (const ticket of [...state.projectionTickets.values()]) {
    if (ticket.generation === generation) {
      deliverProjectionTerminal(state, ticket, terminal)
    }
  }
}

function publishCapturedProjectionTerminal(
  state: ManagerState,
  captured: readonly ProjectionTicketState[],
  terminal: "negative" | "error",
) {
  try { state.assertActive() } catch { return }
  if (managers.get(state.queryClient) !== state) return
  const generations = new Set<number>()
  for (const original of captured) {
    const current = state.projectionTickets.get(original.ticket.token)
    if (!current || current.ticket.epoch !== original.ticket.epoch || current.generation !== original.generation) continue
    if (current.generation !== null) generations.add(current.generation)
    else deliverProjectionTerminal(state, current, terminal)
  }
  for (const generation of generations) publishProjectionTerminal(state, generation, terminal)
}

function isHandoffProjectionTarget(target: InboxRowTarget, handoff: ThreadOpenerHandoffTarget) {
  return target.kind === "thread"
    && target.serverId === handoff.serverId
    && target.parentChannelId === handoff.parentChannelId
    && target.childChannelId === handoff.childChannelId
    && target.confirmationChannelId === handoff.parentChannelId
}

function activeLease(state: ManagerState) {
  return state.latestToken ? state.leases.get(state.latestToken) ?? null : null
}

function notifyActive(state: ManagerState, candidate: InboxReadCandidate | null) {
  try { state.assertActive() } catch { return }
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

function queueAuthoritativeRefetch(state: ManagerState) {
  if (state.disposed || state.refetch) return state.refetch ?? Promise.resolve()
  const queryKey = communityKeys.accountAttention()
  const original = Promise.resolve().then(() => {
      state.assertActive()
      return state.queryClient.cancelQueries({ queryKey, exact: true })
    }).then(() => {
      state.assertActive()
      return state.queryClient.invalidateQueries({ queryKey, exact: true, refetchType: "active" })
    }).then(() => { state.assertActive() })
    .finally(() => {
      if (state.refetch === original) state.refetch = null
    })
  state.refetch = original
  return original
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
    pendingTerminal: null,
    generation: null,
    onReceipt,
    attentionOptimistic: null,
  }
  const focused = state.focusedCandidate
  if (focused && targetMatchesCandidate(target, focused.candidate)) {
    ticketState.generation = focused.generation
  }
  if (ticketState.generation === null) {
    const generations = [...state.projectionCandidates.entries()].reverse()
    const match = generations.find(([, candidate]) => targetMatchesCandidate(target, candidate))
    if (match) ticketState.generation = match[0]
  }
  setManagerMap(state, "projectionTickets", ticket.token, ticketState)
  return ticket
}

export function activateInboxProjectionTicket(ticket: InboxProjectionTicket) {
  const state = managers.get(ticket.queryClient)
  const current = state?.projectionTickets.get(ticket.token)
  if (!state || !current || current.ticket.epoch !== ticket.epoch) return false
  const active = beginProjectionAttention({ ...current, active: true })
  setManagerMap(state, "projectionTickets", ticket.token, active)
  const terminal = active.pendingTerminal ?? (active.generation === null
    ? null
    : state.projectionTerminals.get(active.generation)?.terminal ?? null)
  if (terminal) deliverProjectionTerminal(state, active, terminal)
  return true
}

export function cancelInboxProjectionTicket(ticket: InboxProjectionTicket) {
  const state = managers.get(ticket.queryClient)
  const current = state?.projectionTickets.get(ticket.token)
  if (!state || !current || !deleteManagerMap(state, "projectionTickets", ticket.token)) return false
  settleProjectionAttention(current, false)
  return true
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
  setManagerMap(state, "leases", token, { lease, onCandidate })
  state.latestToken = token
  if (state.focusedCandidate?.epoch !== lease.epoch) {
    settleFocusedAttention(queryClient, state.focusedCandidate, false)
    state.focusedCandidate = null
  }
  return lease
}

export function armInboxReadReservationCandidate(
  queryClient: QueryClient,
  input: {
    channelId: string
    lastMessageAt: string
    openerMessageId?: string
    openerSeq?: number
    seq?: number
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
    settleFocusedAttention(queryClient, current, false)
  }
  state.focusedCandidate = {
    epoch: lease.lease.epoch,
    candidate,
    generation: null,
    attentionOptimistic: (() => {
      if (input.seq === undefined) return null
      const registry = getCommunityDbRegistry(queryClient)
      if (!registry || hasAttentionScopeOptimisticFence(
        queryClient,
        input.channelId,
        input.seq,
      )) return null
      return {
        registry,
        snapshot: clearAttentionScopeOptimistically(
          registry,
          input.channelId,
          input.seq,
        ),
      }
    })(),
  }
  bindProjectionTickets(state, candidate, null)
  notifyActive(state, candidate)
  return true
}

export function releaseInboxReadReservationSurface(lease: InboxReadReservationLease) {
  const state = managers.get(lease.queryClient)
  if (!state || state.disposed) return
  deleteManagerMap(state, "leases", lease.token)
  if (state.latestToken !== lease.token) return
  state.latestToken = null
  if (state.focusedCandidate?.epoch === lease.epoch) {
    settleFocusedAttention(lease.queryClient, state.focusedCandidate, false)
    state.focusedCandidate = null
  }

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
    state.focusedCandidate = { ...state.focusedCandidate, generation }
    rememberProjectionCandidate(
      state,
      generation,
      state.focusedCandidate.candidate,
    )
  }
  return true
}

export function takeInboxReadReservationNegative(lease: InboxReadReservationLease) {
  const state = managers.get(lease.queryClient)
  const current = state?.leases.get(lease.token)
  if (!state || !current || current.lease.epoch !== lease.epoch) return false
  const focused = state.focusedCandidate
  if (focused?.epoch === lease.epoch && focused.candidate.channelId === lease.channelId && focused.generation === null) {
    settleFocusedAttention(lease.queryClient, focused, false)
    state.focusedCandidate = null
    notifyActive(state, null)
    const captured = [...state.projectionTickets.values()].filter((ticket) => targetMatchesCandidate(ticket.target, focused.candidate))
    void queueAuthoritativeRefetch(state).then(
      () => publishCapturedProjectionTerminal(state, captured, "negative"),
      () => publishCapturedProjectionTerminal(state, captured, "error"),
    )
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
  deleteManagerMap(state, "claimedOpeners", generation)
  if (!committed) {
    const lease = activeLease(state)
    if (lease?.lease.channelId !== (claimed?.childChannelId ?? channelId)) return
    if (state.focusedCandidate?.generation === generation) {
      settleFocusedAttention(queryClient, state.focusedCandidate, false)
      state.focusedCandidate = null
      notifyActive(state, null)
    }
    try {
      await queueAuthoritativeRefetch(state)
      publishProjectionTerminal(state, generation, "negative")
    } catch {
      publishProjectionTerminal(state, generation, "error")
    }
    return
  }
  const focused = state.focusedCandidate
  if (focused?.generation !== generation) return
  const settled = settleFocusedAttention(queryClient, focused, true)
  const settledFocused = state.focusedCandidate
  await settled
  try { state.assertActive() } catch { return }
  if (state.focusedCandidate !== settledFocused) return
  state.focusedCandidate = null
  notifyActive(state, null)
}

export function armThreadOpenerReservationHandoff(
  queryClient: QueryClient,
  target: ThreadOpenerHandoffTarget,
) {
  const state = managerFor(queryClient)
  if (state.handoff) terminateThreadOpenerReservationHandoff(queryClient, state.handoff.nonce)
  state.handoff = { ...target, projectionTickets: [...state.projectionTickets.values()].filter((ticket) => isHandoffProjectionTarget(ticket.target, target)).map((ticket) => ticket.ticket) }
}

export function getThreadOpenerReservationHandoff(queryClient: QueryClient, nonce: string): ThreadOpenerHandoffTarget | null {
  const handoff = managerFor(queryClient).handoff
  if (handoff?.nonce !== nonce) return null
  return { nonce: handoff.nonce, serverId: handoff.serverId, parentChannelId: handoff.parentChannelId, childChannelId: handoff.childChannelId, openerMessageId: handoff.openerMessageId, openerSeq: handoff.openerSeq }
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
  setManagerMap(state, "routeLeases", lease.token, lease)
  return lease
}

export function releaseThreadOpenerRouteLease(lease: ThreadOpenerRouteLease) {
  const state = managers.get(lease.queryClient)
  if (!state || state.disposed || !deleteManagerMap(state, "routeLeases", lease.token)) return
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
  for (const owned of handoff.projectionTickets) {
    const ticket = state.projectionTickets.get(owned.token)
    if (!ticket || ticket.ticket.epoch !== owned.epoch) continue
    const bound = { ...ticket, generation, pendingTerminal: ticket.generation === generation ? ticket.pendingTerminal : null }
    setManagerMap(state, "projectionTickets", ticket.ticket.token, bound)
    const terminal = state.projectionTerminals.get(generation)?.terminal
    if (terminal) deliverProjectionTerminal(state, bound, terminal)
  }
  setManagerMap(state, "claimedOpeners", generation, { nonce: handoff.nonce, serverId: handoff.serverId, parentChannelId: handoff.parentChannelId, childChannelId: handoff.childChannelId, openerMessageId: handoff.openerMessageId, openerSeq: handoff.openerSeq, generation })
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
  state.handoff = null
  const captured = handoff.projectionTickets.flatMap((owned) => {
    const current = state.projectionTickets.get(owned.token)
    return current?.ticket.epoch === owned.epoch ? [current] : []
  })
  void queueAuthoritativeRefetch(state).then(
    () => publishCapturedProjectionTerminal(state, captured, "negative"),
    () => publishCapturedProjectionTerminal(state, captured, "error"),
  )
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
  clearManagerMap(state, "claimedOpeners")
  clearManagerMap(state, "routeLeases")
  settleFocusedAttention(queryClient, state.focusedCandidate, true)
  state.focusedCandidate = null
  clearManagerMap(state, "leases")
  state.latestToken = null
  for (const ticket of state.projectionTickets.values()) {
    settleProjectionAttention(ticket, true)
  }
  clearManagerMap(state, "projectionTickets")
  clearManagerMap(state, "projectionCandidates")
  clearManagerMap(state, "projectionTerminals")
  managers.delete(queryClient)
}
