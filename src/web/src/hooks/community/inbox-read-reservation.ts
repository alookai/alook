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
  commitAttentionScopeOptimisticSnapshot,
  hasAttentionScopeOptimisticFence,
  restoreAttentionScopeOptimisticSnapshot,
  type AttentionScopeOptimisticSnapshot,
} from "@/lib/community-db/sync"
import { reconcileAccountAttention } from "./use-account-attention"

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
  attentionOptimistic: CanonicalAttentionOptimistic | null
}

type ResponsePermit = {
  epoch: number
  channelId: string
  lastMessageAt: string | null
  fingerprint: string | null
}

type ManagerData = {
  queryClient: QueryClient
  leases: ReadonlyMap<symbol, LeaseState>
  latestToken: symbol | null
  nextEpoch: number
  nextResponseId: number
  held: ReadonlyMap<number, HeldResponse>
  focusedCandidate: FocusedCandidate | null
  discardedCandidate: { epoch: number; candidate: InboxReadCandidate } | null
  permit: ResponsePermit | null
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
  candidate: InboxReadCandidate | null
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
  get nextResponseId() { return this.store.get().nextResponseId }
  set nextResponseId(value: ManagerData["nextResponseId"]) { this.store.setState((state) => state.nextResponseId === value ? state : { ...state, nextResponseId: value }) }
  get held() { return this.store.get().held }
  set held(value: ManagerData["held"]) { this.store.setState((state) => state.held === value ? state : { ...state, held: value }) }
  get focusedCandidate() { return this.store.get().focusedCandidate }
  set focusedCandidate(value: ManagerData["focusedCandidate"]) { this.store.setState((state) => state.focusedCandidate === value ? state : { ...state, focusedCandidate: value }) }
  get discardedCandidate() { return this.store.get().discardedCandidate }
  set discardedCandidate(value: ManagerData["discardedCandidate"]) { this.store.setState((state) => state.discardedCandidate === value ? state : { ...state, discardedCandidate: value }) }
  get permit() { return this.store.get().permit }
  set permit(value: ManagerData["permit"]) { this.store.setState((state) => state.permit === value ? state : { ...state, permit: value }) }
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
  if (!ticket.active || !deleteManagerMap(state, "projectionTickets", ticket.ticket.token)) return
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
    return commitAttentionScopeOptimisticSnapshot(optimistic.registry, optimistic.snapshot)
  }
  if (!restoreAttentionScopeOptimisticSnapshot(optimistic.registry, optimistic.snapshot)) {
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
    const current = generation !== null ? { ...ticket, generation } : ticket
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
  const candidate = state.projectionCandidates.get(generation) ?? null
  setManagerMap(state, "projectionTerminals", generation, { terminal, candidate })
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
  if (!deleteManagerMap(state, "held", held.id)) return
  held.removeAbort()
  held.reject(new DOMException("Inbox response superseded", "AbortError"))
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
    const claimed = claimedOpenerForCandidate(state, candidate)
    const current = { ...held, candidate, generation: claimed?.generation ?? null, openerClaimLocked: claimed !== null }
    setManagerMap(state, "held", held.id, current)
    if (shouldAwaitOpenerClaim(state, candidate) && state.handoff) {
      state.handoff = { ...state.handoff, phase: "awaiting-opener-claim" }
    }
    bindProjectionTickets(state, candidate, current.generation)
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
  const terminal = active.generation === null
    ? null
    : state.projectionTerminals.get(active.generation)?.terminal ?? null
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
    state.focusedCandidate = { ...state.focusedCandidate, generation }
    rememberProjectionCandidate(
      state,
      generation,
      state.focusedCandidate.candidate,
    )
  }
  for (const held of state.held.values()) {
    if (held.candidate.channelId === lease.channelId && !held.openerClaimLocked) {
      setManagerMap(state, "held", held.id, { ...held, generation })
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
    settleFocusedAttention(lease.queryClient, focused, false)
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
    deleteManagerMap(state, "claimedOpeners", generation)
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
        settleFocusedAttention(queryClient, state.focusedCandidate, false)
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
    if (state.focusedCandidate?.generation === generation) {
      settleFocusedAttention(queryClient, state.focusedCandidate, false)
      state.focusedCandidate = null
    }
    return
  }
  if (matching.length === 0 && !claimed) {
    const focused = state.focusedCandidate
    if (committed && focused?.generation === generation) {
      await settleFocusedAttention(queryClient, focused, true)
      try { state.assertActive() } catch { return }
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
  try { state.assertActive() } catch { return }
  deleteManagerMap(state, "claimedOpeners", generation)
  for (const held of [...state.held.values()]) {
    if (held.generation === generation) cancelHeld(state, held)
  }
  if (state.focusedCandidate?.generation === generation) {
    await settleFocusedAttention(queryClient, state.focusedCandidate, true)
    try { state.assertActive() } catch { return }
    state.focusedCandidate = null
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
      attentionOptimistic: armed.attentionOptimistic,
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
      deleteManagerMap(state, "held", id)
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
    setManagerMap(state, "held", id, held)
    if (focused) {
      state.focusedCandidate = { ...focused, candidate }
    }
    if (shouldAwaitOpenerClaim(state, candidate) && state.handoff) {
      state.handoff = { ...state.handoff, phase: "awaiting-opener-claim" }
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
  setManagerMap(state, "routeLeases", lease.token, lease)
  const handoff = state.handoff
  if (
    handoff?.phase === "armed"
    && hasExactRouteLease(state, handoff)
    && [...state.held.values()].some((held) => handoffMatches(handoff, held.candidate))
  ) {
    state.handoff = { ...handoff, phase: "awaiting-opener-claim" }
  }
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
  for (const held of state.held.values()) {
    if (handoffMatches(handoff, held.candidate)) {
      setManagerMap(state, "held", held.id, { ...held, generation, openerClaimLocked: true })
      rememberProjectionCandidate(state, generation, held.candidate)
    }
  }
  setManagerMap(state, "claimedOpeners", generation, { ...handoff, generation })
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
  clearManagerMap(state, "claimedOpeners")
  clearManagerMap(state, "routeLeases")
  settleFocusedAttention(queryClient, state.focusedCandidate, true)
  state.focusedCandidate = null
  state.discardedCandidate = null
  state.permit = null
  clearManagerMap(state, "leases")
  state.latestToken = null
  for (const ticket of state.projectionTickets.values()) {
    settleProjectionAttention(ticket, true)
  }
  clearManagerMap(state, "projectionTickets")
  clearManagerMap(state, "projectionCandidates")
  clearManagerMap(state, "projectionTerminals")
  for (const held of [...state.held.values()]) cancelHeld(state, held)
  managers.delete(queryClient)
}
