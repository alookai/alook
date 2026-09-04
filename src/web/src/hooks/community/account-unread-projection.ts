"use client"

import type { QueryClient } from "@tanstack/react-query"

export type AccountUnreadFamily =
  | "servers"
  | `server-detail:${string}`
  | "inbox-unreads"
  | "inbox-mentions"
  | "dms"

export type AccountUnreadDomain = "channels" | "dms" | "mentions"

export type AccountUnreadArrival = {
  channelId: string
  railChannelId?: string
  serverId?: string
  messageId?: string
  attentionId?: string
  seq?: number
  isMention?: boolean
}

export type AccountUnreadSource = {
  channelId: string
  lastUnreadSeq: number
  mentionCount?: number
  lastMentionSeq?: number | null
  serverId?: string
  railChannelId?: string
  messageId?: string
  attentionId?: string
  isMention?: boolean
}

export type AccountUnreadPresentationExclusion = {
  channelId: string
  throughSeq?: number
}

export type AccountUnreadLegacySource = {
  family: AccountUnreadFamily
  channelId: string
  serverId?: string
  railChannelId?: string
  isMention?: boolean
}

type PendingArrival = {
  key: string
  channelId: string
  serverId?: string
  railChannelId?: string
  seq: number
  ordinal: number
  isMention: boolean
  attentionIds: Set<string>
  families: Map<AccountUnreadFamily, number>
}

type StickyUnknown = {
  channelId: string
  serverId?: string
  railChannelId?: string
  messageId?: string
  isMention: boolean
  attentionIds: Set<string>
  families: Map<AccountUnreadFamily, { boundary: number; ordinal: number }>
}

export type AccountUnreadFacet = "ordinary" | "attention"

type AccountUnreadPolicyLevel = "all" | "mentions" | "nothing"

export type AccountUnreadPolicySnapshot = {
  all?: AccountUnreadPolicyLevel | string
  server?: Readonly<Record<string, AccountUnreadPolicyLevel | string>>
  channel?: Readonly<Record<string, AccountUnreadPolicyLevel | string>>
  parentByChannel?: Readonly<Record<string, string>>
}

export type AccountUnreadPolicyPatch =
  | { kind: "server"; id: string; level: AccountUnreadPolicyLevel | string }
  | { kind: "channel"; id: string; level: AccountUnreadPolicyLevel | string | null }

export type AccountUnreadPolicyToken = {
  nonce: symbol
  ownerEpoch: number
}

type FrozenPolicy = {
  all: AccountUnreadPolicyLevel
  server: ReadonlyMap<string, AccountUnreadPolicyLevel>
  channel: ReadonlyMap<string, AccountUnreadPolicyLevel>
  parentByChannel: ReadonlyMap<string, string>
}

type MutablePolicy = {
  all: AccountUnreadPolicyLevel
  server: Map<string, AccountUnreadPolicyLevel>
  channel: Map<string, AccountUnreadPolicyLevel>
  parentByChannel: Map<string, string>
}

export type AccountUnreadSnapshotToken = {
  family: AccountUnreadFamily
  domain: AccountUnreadDomain
  startOrdinal: number
  policyGeneration: number
  eligibleCoverage: ReadonlySet<AccountUnreadFacet>
  nonce: symbol
  ownerEpoch: number
  policy: FrozenPolicy
}

export type AccountUnreadScope =
  | { kind: "server"; serverId: string }
  | { kind: "channel"; channelId: string }

export type AccountUnreadScopeToken = {
  scope: AccountUnreadScope
  ordinal: number
  nonce: symbol
  ownerEpoch: number
}

export type AccountUnreadDismissToken = {
  mentionId: string
  channelId: string
  seq?: number
  ordinal: number
  nonce: symbol
  ownerEpoch: number
}

export type MarkAllToken = {
  domain: AccountUnreadDomain
  ordinal: number
  nonce: symbol
}

type MarkAllFence = MarkAllToken & {
  state: "pending" | "committed"
  revision: number | null
}

export const MAX_EXACT_ARRIVALS = 512
export const MAX_EXACT_ARRIVALS_PER_CHANNEL = 64
export const MAX_STICKY_SCOPES = 256

const owners = new WeakMap<QueryClient, Map<string, AccountUnreadProjection>>()
const activeOwners = new WeakMap<QueryClient, string>()

function familiesFor(arrival: AccountUnreadArrival): AccountUnreadFamily[] {
  const families: AccountUnreadFamily[] = ["inbox-unreads"]
  if (arrival.serverId) {
    families.push("servers", `server-detail:${arrival.serverId}`)
  } else {
    families.push("dms")
  }
  if (arrival.isMention) families.push("inbox-mentions")
  return families
}

function familyDomain(family: AccountUnreadFamily): AccountUnreadDomain {
  if (family === "dms") return "dms"
  if (family === "inbox-mentions") return "mentions"
  return "channels"
}

function arrivalDomain(
  family: AccountUnreadFamily,
  serverId: string | undefined,
): AccountUnreadDomain {
  if (family === "inbox-mentions") return "mentions"
  return serverId ? "channels" : "dms"
}

function excludesUnread(
  exclusion: AccountUnreadPresentationExclusion | null | undefined,
  channelId: string,
  seq?: number | null,
) {
  if (!exclusion || exclusion.channelId !== channelId) return false
  if (exclusion.throughSeq === undefined) return true
  return seq !== undefined && seq !== null && seq <= exclusion.throughSeq
}

function normalizePolicyLevel(value?: string): AccountUnreadPolicyLevel {
  const normalized = value?.trim().toLowerCase()
  if (normalized === "nothing") return "nothing"
  if (normalized === "mentions" || normalized?.includes("mention")) return "mentions"
  return "all"
}

function freezePolicy(snapshot: AccountUnreadPolicySnapshot): MutablePolicy {
  return {
    all: normalizePolicyLevel(snapshot.all),
    server: new Map(Object.entries(snapshot.server ?? {}).map(([id, level]) => (
      [id, normalizePolicyLevel(level)]
    ))),
    channel: new Map(Object.entries(snapshot.channel ?? {}).map(([id, level]) => (
      [id, normalizePolicyLevel(level)]
    ))),
    parentByChannel: new Map(Object.entries(snapshot.parentByChannel ?? {})),
  }
}

function policySignature(policy: FrozenPolicy) {
  const sortEntries = <T,>(values: ReadonlyMap<string, T>) => (
    [...values.entries()].sort(([left], [right]) => left.localeCompare(right))
  )
  return JSON.stringify([
    policy.all,
    sortEntries(policy.server),
    sortEntries(policy.channel),
    sortEntries(policy.parentByChannel),
  ])
}

function scopeKey(scope: AccountUnreadScope) {
  return scope.kind === "server"
    ? `server:${scope.serverId}`
    : `channel:${scope.channelId}`
}

/**
 * Account-wide optimistic unread ledger. Raw TanStack resources remain
 * authoritative and feed evidence into this synchronous projection; the
 * owner may request their coalesced reconciliation but owns no transport,
 * timer, cache write, or route transition itself.
 */
export class AccountUnreadProjection {
  private ordinal = 0
  private version = 0
  private ownerEpoch = 0
  private disposed = false
  private highestRevision = -1
  private policyGeneration = 0
  private policyReady = false
  private policy: FrozenPolicy = {
    all: "all",
    server: new Map(),
    channel: new Map(),
    parentByChannel: new Map(),
  }
  private policyBase: MutablePolicy = {
    all: "all",
    server: new Map(),
    channel: new Map(),
    parentByChannel: new Map(),
  }
  private readonly policyOverlays = new Map<symbol, {
    patch: AccountUnreadPolicyPatch
    state: "pending" | "committed"
  }>()
  private reconcileScheduled = false
  private reconcilePendingDelivery = false
  private lastPolicyReconcileGeneration = -1
  private prePolicySnapshotNeedsReconcile = false
  private reconcile: (() => void) | null = null
  private readonly listeners = new Set<() => void>()
  private readonly exact = new Map<string, PendingArrival>()
  private readonly exactByChannel = new Map<string, Set<string>>()
  private readonly sticky = new Map<string, StickyUnknown>()
  private readonly evidence = new Map<string, number>()
  private readonly readSeq = new Map<string, number>()
  private readonly optimisticReads = new Map<
    number,
    { channelId: string; seq: number; committed: boolean }
  >()
  private readonly markAll = new Map<AccountUnreadDomain, MarkAllFence>()
  private readonly accessFences = new Map<
    string,
    AccountUnreadScopeToken & { state: "pending" | "committed" }
  >()
  private readonly dismissals = new Map<
    symbol,
    AccountUnreadDismissToken & { state: "pending" | "committed" }
  >()
  private readonly snapshots = new Set<symbol>()
  private readonly legacySnapshots = new WeakSet<object>()

  constructor(readonly ownerUserId: string) {}

  subscribe = (listener: () => void) => {
    if (this.disposed) return () => undefined
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = () => this.version

  setReconcileScheduler(reconcile: (() => void) | null) {
    if (this.disposed) return
    this.reconcile = reconcile
    if (reconcile && this.reconcilePendingDelivery) {
      this.reconcilePendingDelivery = false
      reconcile()
    }
  }

  recordArrival(arrival: AccountUnreadArrival) {
    this.recordArrivalForFamilies(arrival, familiesFor(arrival))
  }

  recordMentionArrival(arrival: AccountUnreadArrival) {
    const knownScope = this.findSourceScope(arrival.channelId)
    const enriched = {
      ...arrival,
      serverId: arrival.serverId ?? knownScope?.serverId,
      railChannelId: arrival.railChannelId ?? knownScope?.railChannelId,
      isMention: true,
    }
    const families: AccountUnreadFamily[] = enriched.serverId
      ? familiesFor(enriched)
      : knownScope?.families.has("dms")
        ? ["inbox-unreads", "inbox-mentions", "dms"]
        : ["inbox-unreads", "inbox-mentions"]
    this.recordArrivalForFamilies(enriched, families)
  }

  recordLegacySnapshot(
    snapshot: object,
    sources: readonly AccountUnreadLegacySource[],
  ) {
    if (this.disposed || this.legacySnapshots.has(snapshot)) return
    this.legacySnapshots.add(snapshot)
    for (const source of sources) {
      this.recordSticky(
        source.channelId,
        [source.family],
        source.isMention === true,
        source.serverId,
        source.railChannelId,
      )
    }
  }

  absorbLegacyServerAggregate(
    serverId: string,
    sources: readonly AccountUnreadSource[],
  ) {
    if (this.disposed || sources.length === 0) return
    const channelId = `\u0000legacy-server:${serverId}`
    const unknown = this.sticky.get(channelId)
    if (!unknown?.families.delete("servers")) return
    if (unknown.families.size === 0) this.sticky.delete(channelId)
    this.publish()
  }

  private recordArrivalForFamilies(
    arrival: AccountUnreadArrival,
    families: AccountUnreadFamily[],
    observedOrdinal?: number,
  ) {
    if (this.disposed || !arrival.channelId || !this.scopeAllowsArrival(arrival)) return
    const seq = arrival.seq
    if (!Number.isSafeInteger(seq) || (seq ?? 0) <= 0) {
      this.recordSticky(
        arrival.channelId,
        families,
        arrival.isMention === true,
        arrival.serverId,
        arrival.railChannelId,
        observedOrdinal,
        arrival.messageId,
        arrival.attentionId,
      )
      return
    }
    if (seq! <= (this.readSeq.get(arrival.channelId) ?? 0)) return
    const key = arrival.messageId
      ? `${arrival.channelId}:${arrival.messageId}`
      : `${arrival.channelId}:seq:${seq}`
    const channelKeys = this.exactByChannel.get(arrival.channelId) ?? new Set<string>()
    const existing = this.exact.get(key) ?? [...channelKeys]
      .map((candidate) => this.exact.get(candidate))
      .find((candidate) => candidate?.seq === seq)
    if (existing) {
      let changed = false
      let membershipOrdinal = this.ordinal
      for (const family of families) {
        const previous = existing.families.get(family)
        if (observedOrdinal !== undefined) {
          if ((previous ?? -1) >= observedOrdinal) continue
          existing.families.set(family, observedOrdinal)
          changed = true
        } else if (previous === undefined) {
          if (!changed) membershipOrdinal = ++this.ordinal
          existing.families.set(family, membershipOrdinal)
          changed = true
        }
      }
      if (!existing.isMention && arrival.isMention === true) {
        existing.isMention = true
        changed = true
      }
      if (arrival.attentionId && !existing.attentionIds.has(arrival.attentionId)) {
        existing.attentionIds.add(arrival.attentionId)
        changed = true
      }
      if (!existing.serverId && arrival.serverId) {
        existing.serverId = arrival.serverId
        changed = true
      }
      if (!existing.railChannelId && arrival.railChannelId) {
        existing.railChannelId = arrival.railChannelId
        changed = true
      }
      if (changed) this.publish()
      return
    }
    if (
      this.exact.size >= MAX_EXACT_ARRIVALS
      || channelKeys.size >= MAX_EXACT_ARRIVALS_PER_CHANNEL
    ) {
      const foldedFamilies = new Set(families)
      let isMention = arrival.isMention === true
      let serverId = arrival.serverId
      let railChannelId = arrival.railChannelId
      const attentionIds = new Set(arrival.attentionId ? [arrival.attentionId] : [])
      for (const exactKey of [...channelKeys]) {
        const folded = this.exact.get(exactKey)!
        for (const family of folded.families.keys()) foldedFamilies.add(family)
        isMention ||= folded.isMention
        serverId ??= folded.serverId
        railChannelId ??= folded.railChannelId
        for (const attentionId of folded.attentionIds) attentionIds.add(attentionId)
        this.removeExact(exactKey)
      }
      this.recordSticky(
        arrival.channelId,
        [...foldedFamilies],
        isMention,
        serverId,
        railChannelId,
        observedOrdinal,
        undefined,
        undefined,
        attentionIds,
      )
      return
    }
    const matchingSticky = this.sticky.get(arrival.channelId)
    const correlatedSticky = arrival.messageId
      && matchingSticky?.messageId === arrival.messageId
      ? matchingSticky
      : undefined
    const pendingOrdinal = observedOrdinal ?? ++this.ordinal
    const pending: PendingArrival = {
      key,
      channelId: arrival.channelId,
      serverId: arrival.serverId ?? correlatedSticky?.serverId,
      railChannelId: arrival.railChannelId ?? correlatedSticky?.railChannelId,
      seq: seq!,
      ordinal: Math.max(
        pendingOrdinal,
        ...[...(correlatedSticky?.families.values() ?? [])].map((membership) => (
          membership.ordinal
        )),
      ),
      isMention: arrival.isMention === true || correlatedSticky?.isMention === true,
      attentionIds: new Set([
        ...(correlatedSticky?.attentionIds ?? []),
        ...(arrival.attentionId ? [arrival.attentionId] : []),
      ]),
      families: new Map(),
    }
    for (const [family, membership] of correlatedSticky?.families ?? []) {
      pending.families.set(family, membership.ordinal)
    }
    for (const family of families) {
      pending.families.set(
        family,
        Math.max(pending.families.get(family) ?? -1, pendingOrdinal),
      )
    }
    if (correlatedSticky) this.sticky.delete(arrival.channelId)
    this.exact.set(key, pending)
    channelKeys.add(key)
    this.exactByChannel.set(arrival.channelId, channelKeys)
    this.publish()
  }

  recordRead(channelId: string, seq: number) {
    if (this.disposed || !Number.isSafeInteger(seq) || seq <= 0) return
    const previous = this.readSeq.get(channelId) ?? 0
    if (seq <= previous) return
    this.readSeq.set(channelId, seq)
    for (const key of this.exactByChannel.get(channelId) ?? []) {
      const arrival = this.exact.get(key)
      if (arrival && arrival.seq <= seq) this.removeExact(key)
    }
    this.publish()
  }

  recordOptimisticRead(channelId: string, seq: number, generation: number) {
    if (this.disposed || !Number.isSafeInteger(seq) || seq <= 0) return
    this.optimisticReads.set(generation, { channelId, seq, committed: false })
    this.publish()
  }

  settleOptimisticRead(
    generation: number,
    committed: boolean,
    confirmedSeq?: number,
  ) {
    if (this.disposed) return
    const optimistic = this.optimisticReads.get(generation)
    if (!optimistic) return
    if (committed) {
      optimistic.seq = Math.max(optimistic.seq, confirmedSeq ?? 0)
      optimistic.committed = true
      this.publish()
      return
    }
    this.optimisticReads.delete(generation)
    this.publish()
  }

  acceptPrimarySnapshot(snapshot: {
    revision: number
    readStates: Array<{ channelId: string; lastReadSeq: number }>
  }) {
    if (this.disposed || snapshot.revision < this.highestRevision) return
    this.highestRevision = snapshot.revision
    for (const row of snapshot.readStates) {
      this.recordRead(row.channelId, row.lastReadSeq)
      for (const [generation, optimistic] of this.optimisticReads) {
        if (
          optimistic.channelId === row.channelId
          && optimistic.seq <= row.lastReadSeq
        ) this.optimisticReads.delete(generation)
      }
    }
    let changed = false
    for (const [domain, fence] of this.markAll) {
      if (
        fence.state === "committed"
        && fence.revision !== null
        && snapshot.revision >= fence.revision
      ) {
        if (!this.hasCapturedDomainSource(domain, fence.ordinal)) {
          this.markAll.delete(domain)
          changed = true
        }
      }
    }
    if (changed) this.publish()
  }

  beginSnapshot(
    family: AccountUnreadFamily,
    domain: AccountUnreadDomain = familyDomain(family),
    eligibleCoverage: Iterable<AccountUnreadFacet> = [
      family === "inbox-mentions" ? "attention" : "ordinary",
    ],
  ): AccountUnreadSnapshotToken {
    this.reconcileScheduled = false
    const token = {
      family,
      domain,
      startOrdinal: this.disposed ? this.ordinal : ++this.ordinal,
      policyGeneration: this.policyGeneration,
      eligibleCoverage: new Set(this.policyReady ? eligibleCoverage : []),
      nonce: Symbol(family),
      ownerEpoch: this.ownerEpoch,
      policy: this.clonePolicy(),
    }
    if (!this.disposed) this.snapshots.add(token.nonce)
    return token
  }

  absorbSnapshot(
    token: AccountUnreadSnapshotToken,
    sources: readonly AccountUnreadSource[],
    options: { truncated?: boolean; stale?: boolean } = {},
  ) {
    if (
      this.disposed
      || token.ownerEpoch !== this.ownerEpoch
      || !this.snapshots.delete(token.nonce)
    ) return
    const family = token.family
    const facet = family === "inbox-mentions" ? "attention" : "ordinary"
    const positiveChannels = new Map<string, number>()
    const positiveAttentionChannels = new Map<string, number>()
    const positiveAttentionIds = new Set(
      sources.flatMap((source) => source.attentionId ? [source.attentionId] : []),
    )
    for (const source of sources) {
      const evidenceSeq = family === "inbox-mentions"
        ? source.lastMentionSeq ?? source.lastUnreadSeq
        : source.lastUnreadSeq
      if (!source.channelId || !Number.isSafeInteger(evidenceSeq) || evidenceSeq <= 0) continue
      positiveChannels.set(
        source.channelId,
        Math.max(positiveChannels.get(source.channelId) ?? 0, evidenceSeq),
      )
      if (family === "inbox-mentions" || source.isMention) {
        positiveAttentionChannels.set(
          source.channelId,
          Math.max(positiveAttentionChannels.get(source.channelId) ?? 0, evidenceSeq),
        )
      }
      this.recordSnapshotSource(family, source, evidenceSeq, token.startOrdinal)
    }

    if (token.policyGeneration !== this.policyGeneration) {
      this.requestPolicyReconcile()
      return
    }
    if (options.stale || options.truncated) return
    if (!token.eligibleCoverage.has(facet)) {
      if (
        !this.policyReady
        && this.snapshotWouldRetire(
          token,
          family,
          facet,
          positiveChannels,
          positiveAttentionChannels,
        )
      ) this.prePolicySnapshotNeedsReconcile = true
      return
    }

    let changed = false
    if (family === "inbox-mentions") {
      for (const [nonce, dismissal] of this.dismissals) {
        if (
          dismissal.state === "committed"
          && dismissal.ordinal < token.startOrdinal
          && !positiveAttentionIds.has(dismissal.mentionId)
        ) {
          this.dismissals.delete(nonce)
          changed = true
        }
      }
    }
    for (const [key, arrival] of [...this.exact]) {
      const membershipOrdinal = arrival.families.get(family)
      if (
        membershipOrdinal === undefined
        || membershipOrdinal > token.startOrdinal
        || arrivalDomain(family, arrival.serverId) !== token.domain
        || !this.policyAllows(arrival, facet, token.policy)
      ) continue
      const positiveSeq = (
        family === "inbox-mentions" || arrival.isMention
          ? positiveAttentionChannels
          : positiveChannels
      ).get(arrival.channelId)
      if (positiveSeq !== undefined && positiveSeq >= arrival.seq) continue
      arrival.families.delete(family)
      if (arrival.families.size === 0) this.removeExact(key)
      changed = true
    }
    for (const [channelId, unknown] of [...this.sticky]) {
      const membership = unknown.families.get(family)
      const positiveSeq = (
        family === "inbox-mentions" || unknown.isMention
          ? positiveAttentionChannels
          : positiveChannels
      ).get(channelId)
      if (
        !membership
        || membership.ordinal > token.startOrdinal
        || arrivalDomain(family, unknown.serverId) !== token.domain
        || !this.policyAllows(unknown, facet, token.policy)
        || (positiveSeq !== undefined && positiveSeq <= membership.boundary)
      ) continue
      // A complete response whose channel evidence advanced past the
      // sticky's previous boundary has materialized that unsequenced source
      // into the exact record added above. Retire only this family membership;
      // other families still need their own complete coverage.
      unknown.families.delete(family)
      if (unknown.families.size === 0) this.sticky.delete(channelId)
      changed = true
    }
    changed = this.settleConfirmedMarkAllFences() || changed
    if (changed) this.publish()
  }

  cancelSnapshot(token: AccountUnreadSnapshotToken) {
    if (!this.validOwnerToken(token)) return
    this.snapshots.delete(token.nonce)
  }

  absorbFamily(
    family: AccountUnreadFamily,
    sources: readonly AccountUnreadSource[],
    options: {
      truncated?: boolean
      stale?: boolean
      domain?: AccountUnreadDomain
    } = {},
  ) {
    if (this.disposed) return
    const token = this.beginSnapshot(
      family,
      options.domain ?? familyDomain(family),
    )
    this.absorbSnapshot(token, sources, options)
  }

  mergeSources(
    family: AccountUnreadFamily,
    sources: readonly AccountUnreadSource[],
    domain: AccountUnreadDomain = familyDomain(family),
  ) {
    const token = this.beginSnapshot(family, domain)
    this.absorbSnapshot(token, sources, { truncated: true })
  }

  projectUnread(
    family: AccountUnreadFamily,
    channelId: string,
    rawUnread: boolean,
    sourceSeq?: number | null,
    domain: AccountUnreadDomain = familyDomain(family),
    exclusion?: AccountUnreadPresentationExclusion | null,
    exactSourceOnly = false,
    attentionId?: string,
  ) {
    if (this.disposed) return false
    const fence = this.markAll.get(domain)
    const read = this.effectiveReadSeq(channelId)
    const facet = family === "inbox-mentions" ? "attention" : "ordinary"
    const policySource = this.sourceScope(channelId, sourceSeq)
    if (!this.scopeAllowed(policySource)) return false
    const rawVisible = rawUnread
      && !(sourceSeq && read >= sourceSeq)
      && !fence
      && !excludesUnread(exclusion, channelId, sourceSeq)
      && this.policyAllows(policySource, facet, this.policy)
      && (facet !== "attention" || !this.attentionIdentityDismissed(
        channelId,
        sourceSeq,
        attentionId,
      ))
    if (rawVisible) return true
    for (const key of this.exactByChannel.get(channelId) ?? []) {
      const arrival = this.exact.get(key)
      if (!arrival || !arrival.families.has(family) || arrival.seq <= read) continue
      if (exactSourceOnly && sourceSeq !== arrival.seq) continue
      if (excludesUnread(exclusion, channelId, arrival.seq)) continue
      const membershipOrdinal = arrival.families.get(family)!
      if (
        (!fence || membershipOrdinal > fence.ordinal)
        && this.policyAllows(arrival, facet, this.policy)
        && (facet !== "attention" || !this.attentionDismissed(arrival))
      ) return true
    }
    if (exactSourceOnly) return false
    const sticky = this.sticky.get(channelId)
    const pending = sticky?.families.get(family)
    if (pending) {
      if (excludesUnread(exclusion, channelId)) return false
      if (
        (!fence || pending.ordinal > fence.ordinal)
        && this.policyAllows(sticky!, facet, this.policy)
      ) return true
    }
    return false
  }

  projectMentionCount(
    family: "servers" | "inbox-mentions",
    channelId: string,
    rawCount: number,
    sourceSeq?: number | null,
    exclusion?: AccountUnreadPresentationExclusion | null,
  ) {
    if (this.disposed) return 0
    const fence = this.markAll.get("mentions")
    const read = this.effectiveReadSeq(channelId)
    const policySource = this.sourceScope(channelId)
    if (!this.scopeAllowed(policySource)) return 0
    let count = !fence
      && !(sourceSeq && read >= sourceSeq)
      && !excludesUnread(exclusion, channelId, sourceSeq)
      && this.policyAllows(policySource, "attention", this.policy)
      ? rawCount
      : 0
    count = Math.max(0, count - this.dismissedAttentionCount(channelId, sourceSeq))
    for (const key of this.exactByChannel.get(channelId) ?? []) {
      const arrival = this.exact.get(key)
      if (
        family === "inbox-mentions"
        && arrival?.isMention
        && arrival.families.has(family)
        && arrival.seq > read
        && !(sourceSeq && sourceSeq >= arrival.seq)
        && !excludesUnread(exclusion, channelId, arrival.seq)
        && (!fence || arrival.families.get(family)! > fence.ordinal)
        && this.policyAllows(arrival, "attention", this.policy)
        && !this.attentionDismissed(arrival)
      ) count += 1
    }
    return count
  }

  projectServerUnread(
    serverId: string,
    sources: readonly AccountUnreadSource[],
    rawUnread = false,
    exclusion?: AccountUnreadPresentationExclusion | null,
  ) {
    if (sources.some((source) => (
      this.projectUnread(
        "servers",
        source.channelId,
        true,
        source.lastUnreadSeq,
        "channels",
        exclusion,
      )
    ))) return true
    void rawUnread
    for (const arrival of this.exact.values()) {
      if (
        arrival.serverId === serverId
        && this.projectUnread(
          "servers",
          arrival.channelId,
          false,
          undefined,
          "channels",
          exclusion,
        )
      ) return true
    }
    for (const unknown of this.sticky.values()) {
      if (
        unknown.serverId === serverId
        && this.projectUnread(
          "servers",
          unknown.channelId,
          false,
          undefined,
          "channels",
          exclusion,
        )
      ) return true
    }
    return false
  }

  projectServerChannelUnread(
    serverId: string,
    channelId: string,
    sources: readonly AccountUnreadSource[],
    rawUnread = false,
    exclusion?: AccountUnreadPresentationExclusion | null,
  ) {
    const family = `server-detail:${serverId}` as const
    if (sources.some((source) => (
      this.projectUnread(
        family,
        source.channelId,
        true,
        source.lastUnreadSeq,
        "channels",
        exclusion,
      )
    ))) return true
    void rawUnread
    for (const arrival of this.exact.values()) {
      if (
        arrival.serverId === serverId
        && (arrival.channelId === channelId || arrival.railChannelId === channelId)
        && this.projectUnread(
          family,
          arrival.channelId,
          false,
          undefined,
          "channels",
          exclusion,
        )
      ) return true
    }
    for (const unknown of this.sticky.values()) {
      if (
        unknown.serverId === serverId
        && (unknown.channelId === channelId || unknown.railChannelId === channelId)
        && this.projectUnread(
          family,
          unknown.channelId,
          false,
          undefined,
          "channels",
          exclusion,
        )
      ) return true
    }
    return false
  }

  projectForumParentUnread(
    serverId: string,
    parentChannelId: string,
    rawBaseUnread: boolean,
    sourceSeq: number | null | undefined,
    renderedChildIds: ReadonlySet<string>,
    exclusion?: AccountUnreadPresentationExclusion | null,
  ) {
    const family = `server-detail:${serverId}` as const
    if (
      this.projectUnread(
        family,
        parentChannelId,
        rawBaseUnread,
        sourceSeq,
        "channels",
        exclusion,
      )
    ) return true
    for (const arrival of this.exact.values()) {
      if (
        arrival.serverId === serverId
        && arrival.railChannelId === parentChannelId
        && !renderedChildIds.has(arrival.channelId)
        && this.projectUnread(
          family,
          arrival.channelId,
          false,
          undefined,
          "channels",
          exclusion,
        )
      ) return true
    }
    for (const unknown of this.sticky.values()) {
      if (
        unknown.serverId === serverId
        && unknown.railChannelId === parentChannelId
        && !renderedChildIds.has(unknown.channelId)
        && this.projectUnread(
          family,
          unknown.channelId,
          false,
          undefined,
          "channels",
          exclusion,
        )
      ) return true
    }
    return false
  }

  projectServerMentionCount(
    _serverId: string,
    sources: ReadonlyArray<{ channelId: string; count: number; lastSeq: number }>,
    rawFallback = 0,
    exclusion?: AccountUnreadPresentationExclusion | null,
  ) {
    void rawFallback
    return sources.reduce((sum, source) => sum + this.projectMentionCount(
      "servers",
      source.channelId,
      source.count,
      source.lastSeq,
      exclusion,
    ), 0)
  }

  hasPending(
    family?: AccountUnreadFamily,
    domain?: AccountUnreadDomain,
    exclusion?: AccountUnreadPresentationExclusion | null,
  ) {
    if (this.disposed) return false
    for (const arrival of this.exact.values()) {
      if (family && !arrival.families.has(family)) continue
      if (!this.scopeAllowed(arrival)) continue
      if (excludesUnread(exclusion, arrival.channelId, arrival.seq)) continue
      const sourceDomain = family === "inbox-mentions" || arrival.isMention && domain === "mentions"
        ? "mentions"
        : arrival.serverId ? "channels" : "dms"
      if (domain && sourceDomain !== domain) continue
      const fence = this.markAll.get(domain ?? sourceDomain)
      const relevantFamily = family ?? [...arrival.families.keys()].find((candidate) => (
        arrivalDomain(candidate, arrival.serverId) === (domain ?? sourceDomain)
      ))
      if (!relevantFamily) continue
      const facet = relevantFamily === "inbox-mentions" ? "attention" : "ordinary"
      const membershipOrdinal = arrival.families.get(relevantFamily)!
      if (
        (!fence || membershipOrdinal > fence.ordinal)
        && this.policyAllows(arrival, facet, this.policy)
        && (facet !== "attention" || !this.attentionDismissed(arrival))
      ) return true
    }
    for (const unknown of this.sticky.values()) {
      if (!this.scopeAllowed(unknown)) continue
      if (excludesUnread(exclusion, unknown.channelId)) continue
      for (const [pendingFamily, pending] of unknown.families) {
        if (family && pendingFamily !== family) continue
        const pendingDomain = arrivalDomain(pendingFamily, unknown.serverId)
        if (domain && pendingDomain !== domain) continue
        const fence = this.markAll.get(domain ?? pendingDomain)
        const facet = pendingFamily === "inbox-mentions" ? "attention" : "ordinary"
        if (
          (!fence || pending.ordinal > fence.ordinal)
          && this.policyAllows(unknown, facet, this.policy)
        ) return true
      }
    }
    return false
  }

  setNotificationPolicy(snapshot: AccountUnreadPolicySnapshot) {
    if (this.disposed) return
    const wasReady = this.policyReady
    const nextBase = freezePolicy(snapshot)
    // Query cache writes mirror optimistic controls for the settings UI. They
    // are not authoritative policy while the matching overlay is unresolved,
    // otherwise a failed request could hydrate its own optimistic value into
    // the base and make rollback ineffective.
    for (const overlay of this.policyOverlays.values()) {
      if (overlay.patch.kind === "server") {
        const prior = this.policyBase.server.get(overlay.patch.id)
        if (prior === undefined) nextBase.server.delete(overlay.patch.id)
        else nextBase.server.set(overlay.patch.id, prior)
      } else {
        const prior = this.policyBase.channel.get(overlay.patch.id)
        if (prior === undefined) nextBase.channel.delete(overlay.patch.id)
        else nextBase.channel.set(overlay.patch.id, prior)
      }
    }
    this.policyBase = nextBase
    const changed = this.refreshPolicy(true)
    if (
      changed
      && (wasReady || this.prePolicySnapshotNeedsReconcile)
    ) this.requestPolicyReconcile()
    this.prePolicySnapshotNeedsReconcile = false
  }

  beginNotificationPolicyOverlay(
    patch: AccountUnreadPolicyPatch,
  ): AccountUnreadPolicyToken {
    const token = { nonce: Symbol(patch.id), ownerEpoch: this.ownerEpoch }
    if (this.disposed) return token
    this.policyOverlays.set(token.nonce, { patch, state: "pending" })
    this.refreshPolicy(false)
    return token
  }

  commitNotificationPolicyOverlay(token: AccountUnreadPolicyToken) {
    if (!this.validOwnerToken(token)) return
    const overlay = this.policyOverlays.get(token.nonce)
    if (!overlay) return
    overlay.state = "committed"
    this.flushCommittedPolicyOverlays()
    this.refreshPolicy(false)
    this.requestPolicyReconcile()
  }

  rollbackNotificationPolicyOverlay(token: AccountUnreadPolicyToken) {
    if (!this.validOwnerToken(token) || !this.policyOverlays.delete(token.nonce)) return
    this.flushCommittedPolicyOverlays()
    this.refreshPolicy(false)
  }

  getPolicyGeneration() {
    return this.policyGeneration
  }

  beginDismissMention(input: {
    mentionId: string
    channelId: string
    seq?: number
  }): AccountUnreadDismissToken {
    const token: AccountUnreadDismissToken = {
      ...input,
      ordinal: this.disposed ? this.ordinal : ++this.ordinal,
      nonce: Symbol(input.mentionId),
      ownerEpoch: this.ownerEpoch,
    }
    if (!this.disposed) {
      this.dismissals.set(token.nonce, { ...token, state: "pending" })
      this.publish()
    }
    return token
  }

  commitDismissMention(token: AccountUnreadDismissToken, _revision?: number) {
    if (!this.validOwnerToken(token)) return
    // The optimistic facet fence remains until the next complete Mentions
    // snapshot supplies matching negative evidence. A revision hint alone is
    // deliberately insufficient to settle a destructive transaction.
    const dismissal = this.dismissals.get(token.nonce)
    if (!dismissal) return
    dismissal.state = "committed"
    this.publish()
  }

  rollbackDismissMention(token: AccountUnreadDismissToken) {
    if (!this.validOwnerToken(token) || !this.dismissals.delete(token.nonce)) return
    this.publish()
  }

  beginScopeRetirement(scope: AccountUnreadScope): AccountUnreadScopeToken {
    const token: AccountUnreadScopeToken = {
      scope,
      ordinal: this.ordinal,
      nonce: Symbol(scope.kind),
      ownerEpoch: this.ownerEpoch,
    }
    if (!this.disposed) {
      this.accessFences.set(scopeKey(scope), { ...token, state: "pending" })
      this.publish()
    }
    return token
  }

  commitScopeRetirement(token: AccountUnreadScopeToken, _revision?: number) {
    if (!this.validOwnerToken(token)) return
    const current = this.accessFences.get(scopeKey(token.scope))
    if (current?.nonce !== token.nonce) return
    current.state = "committed"
    this.pruneScope(token.scope, this.ordinal)
    this.publish()
  }

  rollbackScopeRetirement(token: AccountUnreadScopeToken) {
    if (!this.validOwnerToken(token)) return
    const key = scopeKey(token.scope)
    if (this.accessFences.get(key)?.nonce !== token.nonce) return
    this.accessFences.delete(key)
    this.publish()
  }

  retireAccessScope(scope: AccountUnreadScope) {
    if (this.disposed) return
    const token = this.beginScopeRetirement(scope)
    this.commitScopeRetirement(token)
  }

  grantAccessScope(scope: AccountUnreadScope) {
    if (this.disposed || !this.accessFences.delete(scopeKey(scope))) return
    this.publish()
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.ownerEpoch += 1
    this.exact.clear()
    this.exactByChannel.clear()
    this.sticky.clear()
    this.evidence.clear()
    this.readSeq.clear()
    this.optimisticReads.clear()
    this.markAll.clear()
    this.accessFences.clear()
    this.dismissals.clear()
    this.snapshots.clear()
    this.policyOverlays.clear()
    this.reconcile = null
    this.reconcileScheduled = false
    this.reconcilePendingDelivery = false
    this.listeners.clear()
    this.version += 1
  }

  inspectForTests() {
    return {
      sourceCount: this.exact.size + this.sticky.size,
      exactCount: this.exact.size,
      stickyCount: this.sticky.size,
      readState: [...this.readSeq.entries()].sort(),
      policyGeneration: this.policyGeneration,
      policyReady: this.policyReady,
      highestRevision: this.highestRevision,
      pendingSnapshots: this.snapshots.size,
      disposed: this.disposed,
    }
  }

  beginMarkAll(domain: AccountUnreadDomain): MarkAllToken {
    if (this.disposed) {
      return { domain, ordinal: this.ordinal, nonce: Symbol(domain) }
    }
    const token: MarkAllToken = { domain, ordinal: this.ordinal, nonce: Symbol(domain) }
    this.markAll.set(domain, { ...token, state: "pending", revision: null })
    this.publish()
    return token
  }

  commitMarkAll(token: MarkAllToken, revision: number) {
    if (this.disposed) return
    const fence = this.markAll.get(token.domain)
    if (!fence || fence.nonce !== token.nonce) return
    fence.state = "committed"
    fence.revision = revision
    this.publish()
  }

  rollbackMarkAll(token: MarkAllToken) {
    if (this.disposed) return
    const fence = this.markAll.get(token.domain)
    if (!fence || fence.nonce !== token.nonce) return
    this.markAll.delete(token.domain)
    this.publish()
  }

  private recordSnapshotSource(
    family: AccountUnreadFamily,
    source: AccountUnreadSource,
    evidenceSeq: number,
    observedOrdinal: number,
  ) {
    const evidenceKey = this.evidenceKey(family, source.channelId)
    this.evidence.set(
      evidenceKey,
      Math.max(this.evidence.get(evidenceKey) ?? 0, evidenceSeq),
    )
    const knownScope = this.findSourceScope(source.channelId)
    const sourceArrival = {
      channelId: source.channelId,
      serverId: source.serverId ?? knownScope?.serverId,
      railChannelId: source.railChannelId ?? knownScope?.railChannelId,
      messageId: source.messageId,
      attentionId: source.attentionId,
      seq: evidenceSeq,
      isMention: source.isMention === true || family === "inbox-mentions",
    }
    const observedFamilies: AccountUnreadFamily[] = family === "inbox-mentions"
      ? sourceArrival.serverId
        ? familiesFor(sourceArrival)
        : knownScope?.families.has("dms")
          ? ["inbox-unreads", "inbox-mentions", "dms"]
          : ["inbox-unreads", "inbox-mentions"]
      : [family]
    for (const key of this.exactByChannel.get(source.channelId) ?? []) {
      const existing = this.exact.get(key)
      if (!existing || existing.seq !== evidenceSeq) continue
      for (const observedFamily of observedFamilies) {
        existing.families.set(
          observedFamily,
          Math.max(existing.families.get(observedFamily) ?? -1, observedOrdinal),
        )
      }
      if (sourceArrival.isMention && !existing.isMention) {
        existing.isMention = true
      }
      if (source.attentionId) existing.attentionIds.add(source.attentionId)
      if (!existing.serverId && source.serverId) {
        existing.serverId = source.serverId
      }
      if (!existing.railChannelId && source.railChannelId) {
        existing.railChannelId = source.railChannelId
      }
      this.publish()
      return
    }
    this.recordArrivalForFamilies(sourceArrival, observedFamilies, observedOrdinal)
  }

  private clonePolicy(): FrozenPolicy {
    return {
      all: this.policy.all,
      server: new Map(this.policy.server),
      channel: new Map(this.policy.channel),
      parentByChannel: new Map(this.policy.parentByChannel),
    }
  }

  private applyPolicyPatch(policy: MutablePolicy, patch: AccountUnreadPolicyPatch) {
    if (patch.kind === "server") {
      policy.server.set(patch.id, normalizePolicyLevel(patch.level))
      return
    }
    if (patch.level === null) policy.channel.delete(patch.id)
    else policy.channel.set(patch.id, normalizePolicyLevel(patch.level))
  }

  private flushCommittedPolicyOverlays() {
    for (const [nonce, overlay] of this.policyOverlays) {
      if (overlay.state !== "committed") break
      this.applyPolicyPatch(this.policyBase, overlay.patch)
      this.policyOverlays.delete(nonce)
    }
  }

  private refreshPolicy(markReady: boolean) {
    const next: MutablePolicy = {
      all: this.policyBase.all,
      server: new Map(this.policyBase.server),
      channel: new Map(this.policyBase.channel),
      parentByChannel: new Map(this.policyBase.parentByChannel),
    }
    for (const overlay of this.policyOverlays.values()) {
      this.applyPolicyPatch(next, overlay.patch)
    }
    const becameReady = markReady && !this.policyReady
    if (!becameReady && policySignature(next) === policySignature(this.policy)) return false
    this.policy = next
    if (markReady) this.policyReady = true
    this.policyGeneration += 1
    this.publish()
    return true
  }

  private policyLevelFor(
    source: Pick<PendingArrival, "channelId" | "serverId" | "railChannelId">,
    policy: FrozenPolicy,
  ) {
    const exact = policy.channel.get(source.channelId)
    if (exact) return exact
    const parentId = source.railChannelId ?? policy.parentByChannel.get(source.channelId)
    if (parentId) {
      const parent = policy.channel.get(parentId)
      if (parent) return parent
    }
    if (source.serverId) return policy.server.get(source.serverId) ?? policy.all
    return policy.all
  }

  private policyAllows(
    source: Pick<PendingArrival, "channelId" | "serverId" | "railChannelId" | "isMention">,
    facet: AccountUnreadFacet,
    policy: FrozenPolicy,
  ) {
    const level = this.policyLevelFor(source, policy)
    if (level === "nothing") return false
    if (facet === "attention") return true
    return level === "all" || source.isMention
  }

  private sourceScope(channelId: string, sourceSeq?: number | null): Pick<
    PendingArrival,
    "channelId" | "serverId" | "railChannelId" | "isMention"
  > {
    if (sourceSeq !== undefined && sourceSeq !== null) {
      for (const key of this.exactByChannel.get(channelId) ?? []) {
        const source = this.exact.get(key)
        if (source?.seq === sourceSeq) return source
      }
    }
    return this.findSourceScope(channelId) ?? {
      channelId,
      isMention: false,
    }
  }

  private findSourceScope(channelId: string): PendingArrival | StickyUnknown | undefined {
    for (const key of this.exactByChannel.get(channelId) ?? []) {
      const source = this.exact.get(key)
      if (source) return source
    }
    return this.sticky.get(channelId)
  }

  private attentionDismissed(
    source: Pick<
      PendingArrival,
      "channelId" | "seq" | "ordinal" | "isMention" | "attentionIds"
    >,
  ) {
    if (!source.isMention) return false
    if (source.attentionIds.size > 0) {
      return [...source.attentionIds].every((attentionId) => (
        this.attentionIdentityDismissed(source.channelId, source.seq, attentionId)
      ))
    }
    for (const dismissal of this.dismissals.values()) {
      if (dismissal.channelId !== source.channelId) continue
      if (dismissal.seq !== undefined && dismissal.seq !== source.seq) continue
      if (source.ordinal <= dismissal.ordinal) return true
    }
    return false
  }

  private attentionIdentityDismissed(
    channelId: string,
    seq?: number | null,
    attentionId?: string,
  ) {
    for (const dismissal of this.dismissals.values()) {
      if (dismissal.channelId !== channelId) continue
      if (attentionId && dismissal.mentionId === attentionId) return true
      if (
        seq !== undefined
        && seq !== null
        && dismissal.seq !== undefined
        && dismissal.seq === seq
      ) return true
    }
    return false
  }

  private dismissedAttentionCount(channelId: string, sourceSeq?: number | null) {
    const identities = new Set<string>()
    for (const dismissal of this.dismissals.values()) {
      if (dismissal.channelId !== channelId) continue
      if (
        sourceSeq !== undefined
        && sourceSeq !== null
        && dismissal.seq !== undefined
        && dismissal.seq > sourceSeq
      ) continue
      identities.add(dismissal.mentionId)
    }
    return identities.size
  }

  private validOwnerToken(token: { ownerEpoch: number }) {
    return !this.disposed && token.ownerEpoch === this.ownerEpoch
  }

  private scopeAllowed(source: { channelId: string; serverId?: string }) {
    if (this.accessFences.has(`channel:${source.channelId}`)) return false
    return !source.serverId || !this.accessFences.has(`server:${source.serverId}`)
  }

  private scopeAllowsArrival(source: { channelId: string; serverId?: string }) {
    if (this.accessFences.get(`channel:${source.channelId}`)?.state === "committed") {
      return false
    }
    return !source.serverId
      || this.accessFences.get(`server:${source.serverId}`)?.state !== "committed"
  }

  private pruneScope(scope: AccountUnreadScope, throughOrdinal: number) {
    const matches = (source: { channelId: string; serverId?: string }) => (
      scope.kind === "server"
        ? source.serverId === scope.serverId
        : source.channelId === scope.channelId
    )
    for (const [key, source] of [...this.exact]) {
      if (!matches(source)) continue
      for (const [family, membershipOrdinal] of [...source.families]) {
        if (membershipOrdinal <= throughOrdinal) source.families.delete(family)
      }
      if (source.families.size === 0) this.removeExact(key)
    }
    for (const [channelId, source] of [...this.sticky]) {
      if (!matches(source)) continue
      for (const [family, membership] of [...source.families]) {
        if (membership.ordinal <= throughOrdinal) source.families.delete(family)
      }
      if (source.families.size === 0) this.sticky.delete(channelId)
    }
  }

  private hasCapturedDomainSource(domain: AccountUnreadDomain, throughOrdinal: number) {
    for (const source of this.exact.values()) {
      for (const [family, membershipOrdinal] of source.families) {
        if (
          membershipOrdinal <= throughOrdinal
          && arrivalDomain(family, source.serverId) === domain
        ) return true
      }
    }
    for (const source of this.sticky.values()) {
      for (const [family, membership] of source.families) {
        if (
          membership.ordinal <= throughOrdinal
          && arrivalDomain(family, source.serverId) === domain
        ) return true
      }
    }
    return false
  }

  private settleConfirmedMarkAllFences() {
    let changed = false
    for (const [domain, fence] of [...this.markAll]) {
      if (
        fence.state === "committed"
        && fence.revision !== null
        && fence.revision <= this.highestRevision
        && !this.hasCapturedDomainSource(domain, fence.ordinal)
      ) {
        this.markAll.delete(domain)
        changed = true
      }
    }
    return changed
  }

  private snapshotWouldRetire(
    token: AccountUnreadSnapshotToken,
    family: AccountUnreadFamily,
    facet: AccountUnreadFacet,
    positiveChannels: ReadonlyMap<string, number>,
    positiveAttentionChannels: ReadonlyMap<string, number>,
  ) {
    for (const arrival of this.exact.values()) {
      const membershipOrdinal = arrival.families.get(family)
      if (
        membershipOrdinal !== undefined
        && membershipOrdinal <= token.startOrdinal
        && arrivalDomain(family, arrival.serverId) === token.domain
        && this.policyAllows(arrival, facet, token.policy)
        && ((family === "inbox-mentions" || arrival.isMention
          ? positiveAttentionChannels
          : positiveChannels
        ).get(arrival.channelId) ?? -1) < arrival.seq
      ) return true
    }
    for (const [channelId, source] of this.sticky) {
      const membership = source.families.get(family)
      if (
        membership
        && membership.ordinal <= token.startOrdinal
        && arrivalDomain(family, source.serverId) === token.domain
        && this.policyAllows(source, facet, token.policy)
        && !(family === "inbox-mentions" || source.isMention
          ? positiveAttentionChannels
          : positiveChannels
        ).has(channelId)
      ) return true
    }
    return false
  }

  private requestPolicyReconcile() {
    if (this.lastPolicyReconcileGeneration === this.policyGeneration) return
    this.lastPolicyReconcileGeneration = this.policyGeneration
    this.requestReconcile()
  }

  private requestReconcile() {
    if (this.disposed || this.reconcileScheduled) return
    this.reconcileScheduled = true
    if (this.reconcile) this.reconcile()
    else this.reconcilePendingDelivery = true
  }

  private recordSticky(
    channelId: string,
    families: AccountUnreadFamily[],
    isMention: boolean,
    serverId?: string,
    railChannelId?: string,
    observedOrdinal?: number,
    messageId?: string,
    attentionId?: string,
    attentionIds: ReadonlySet<string> = new Set(),
  ) {
    if (this.disposed || !channelId || !this.scopeAllowsArrival({ channelId, serverId })) return
    const arrivalOrdinal = observedOrdinal ?? ++this.ordinal
    let unknown = this.sticky.get(channelId)
    if (!unknown) {
      if (this.sticky.size >= MAX_STICKY_SCOPES) {
        const oldest = [...this.sticky.entries()].reduce<
          [string, StickyUnknown] | null
        >((candidate, entry) => {
          if (!candidate) return entry
          const oldestOrdinal = Math.min(...[...candidate[1].families.values()].map((v) => v.ordinal))
          const entryOrdinal = Math.min(...[...entry[1].families.values()].map((v) => v.ordinal))
          return entryOrdinal < oldestOrdinal ? entry : candidate
        }, null)
        if (oldest) this.sticky.delete(oldest[0])
        this.requestReconcile()
      }
      unknown = {
        channelId,
        serverId,
        railChannelId,
        messageId,
        isMention,
        attentionIds: new Set([
          ...attentionIds,
          ...(attentionId ? [attentionId] : []),
        ]),
        families: new Map(),
      }
      this.sticky.set(channelId, unknown)
    } else if (unknown.messageId !== messageId) {
      // A channel-scoped sticky may summarize more than one unsequenced
      // arrival. Once identities disagree it is no longer safe to correlate
      // the aggregate with a later exact message.
      unknown.messageId = undefined
    }
    unknown.isMention ||= isMention
    if (attentionId) unknown.attentionIds.add(attentionId)
    for (const id of attentionIds) unknown.attentionIds.add(id)
    unknown.serverId ??= serverId
    unknown.railChannelId ??= railChannelId
    for (const family of families) {
      const pending = unknown.families.get(family)
      if (pending) {
        pending.ordinal = arrivalOrdinal
      } else {
        unknown.families.set(
          family,
          {
            boundary: this.evidence.get(this.evidenceKey(family, channelId)) ?? 0,
            ordinal: arrivalOrdinal,
          },
        )
      }
    }
    this.publish()
  }

  private evidenceKey(family: AccountUnreadFamily, channelId: string) {
    return `${family}\u0000${channelId}`
  }

  private effectiveReadSeq(channelId: string) {
    let seq = this.readSeq.get(channelId) ?? 0
    for (const optimistic of this.optimisticReads.values()) {
      if (optimistic.channelId === channelId) seq = Math.max(seq, optimistic.seq)
    }
    return seq
  }

  private removeExact(key: string) {
    const arrival = this.exact.get(key)!
    this.exact.delete(key)
    const channelKeys = this.exactByChannel.get(arrival.channelId)
    channelKeys?.delete(key)
    if (channelKeys?.size === 0) this.exactByChannel.delete(arrival.channelId)
  }

  private publish() {
    this.version += 1
    for (const listener of this.listeners) listener()
  }
}

export function getAccountUnreadProjection(
  queryClient: QueryClient,
  ownerUserId: string,
) {
  if (ownerUserId !== "__anonymous__") activeOwners.set(queryClient, ownerUserId)
  let byUser = owners.get(queryClient)
  if (!byUser) {
    byUser = new Map()
    owners.set(queryClient, byUser)
  }
  let projection = byUser.get(ownerUserId)
  if (!projection) {
    projection = new AccountUnreadProjection(ownerUserId)
    byUser.set(ownerUserId, projection)
  }
  return projection
}

export function getActiveAccountUnreadProjection(queryClient: QueryClient) {
  return getAccountUnreadProjection(
    queryClient,
    activeOwners.get(queryClient) ?? "__anonymous__",
  )
}

export function disposeAccountUnreadProjection(
  queryClient: QueryClient,
  ownerUserId?: string,
) {
  const byUser = owners.get(queryClient)
  if (!byUser) return
  if (ownerUserId) {
    byUser.get(ownerUserId)?.dispose()
    byUser.delete(ownerUserId)
  } else {
    for (const projection of byUser.values()) projection.dispose()
    byUser.clear()
  }
  if (!ownerUserId || activeOwners.get(queryClient) === ownerUserId) {
    activeOwners.delete(queryClient)
  }
  if (byUser.size === 0) owners.delete(queryClient)
}

export function acceptAccountUnreadPrimarySnapshot(
  queryClient: QueryClient,
  snapshot: {
    revision: number
    readStates: Array<{ channelId: string; lastReadSeq: number }>
  },
) {
  const ownerUserId = activeOwners.get(queryClient)
  if (!ownerUserId) return
  owners.get(queryClient)?.get(ownerUserId)?.acceptPrimarySnapshot(snapshot)
}
