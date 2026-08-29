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
  seq?: number
  isMention?: boolean
}

export type AccountUnreadSource = {
  channelId: string
  lastUnreadSeq: number
  mentionCount?: number
  lastMentionSeq?: number | null
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
  families: Set<AccountUnreadFamily>
}

type StickyUnknown = {
  channelId: string
  serverId?: string
  railChannelId?: string
  isMention: boolean
  families: Map<AccountUnreadFamily, { boundary: number; ordinal: number }>
}

type OverflowSentinel = {
  ordinal: number
  witnessChannelId: string | null
  witnessFamily: AccountUnreadFamily | null
  boundary: number
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

function sentinelFamily(family: AccountUnreadFamily) {
  return family.startsWith("server-detail:") ? "server-detail" : family
}

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

function sentinelKey(family: AccountUnreadFamily, domain: AccountUnreadDomain) {
  return `${sentinelFamily(family)}\u0000${domain}`
}

/**
 * Account-wide optimistic unread ledger. It deliberately owns no fetches,
 * timers, cache writes, or route transitions: raw TanStack resources remain
 * authoritative and feed evidence into this synchronous projection.
 */
export class AccountUnreadProjection {
  private ordinal = 0
  private version = 0
  private readonly listeners = new Set<() => void>()
  private readonly exact = new Map<string, PendingArrival>()
  private readonly exactByChannel = new Map<string, Set<string>>()
  private readonly sticky = new Map<string, StickyUnknown>()
  private readonly sentinels = new Map<string, OverflowSentinel>()
  private readonly evidence = new Map<string, number>()
  private readonly readSeq = new Map<string, number>()
  private readonly optimisticReads = new Map<
    number,
    { channelId: string; seq: number; committed: boolean }
  >()
  private readonly markAll = new Map<AccountUnreadDomain, MarkAllFence>()
  private readonly legacySnapshots = new WeakSet<object>()

  constructor(readonly ownerUserId: string) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = () => this.version

  recordArrival(arrival: AccountUnreadArrival) {
    this.recordArrivalForFamilies(arrival, familiesFor(arrival))
  }

  recordMentionArrival(arrival: AccountUnreadArrival) {
    this.recordArrivalForFamilies(arrival, ["inbox-mentions"])
  }

  recordLegacySnapshot(
    snapshot: object,
    sources: readonly AccountUnreadLegacySource[],
  ) {
    if (this.legacySnapshots.has(snapshot)) return
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

  private recordArrivalForFamilies(
    arrival: AccountUnreadArrival,
    families: AccountUnreadFamily[],
  ) {
    if (!arrival.channelId) return
    const seq = arrival.seq
    if (!Number.isSafeInteger(seq) || (seq ?? 0) <= 0) {
      this.recordSticky(
        arrival.channelId,
        families,
        arrival.isMention === true,
        arrival.serverId,
        arrival.railChannelId,
      )
      return
    }
    const key = arrival.messageId
      ? `${arrival.channelId}:${arrival.messageId}`
      : `${arrival.channelId}:seq:${seq}`
    const existing = this.exact.get(key)
    if (existing) {
      for (const family of families) existing.families.add(family)
      existing.isMention ||= arrival.isMention === true
      existing.serverId ??= arrival.serverId
      existing.railChannelId ??= arrival.railChannelId
      this.publish()
      return
    }
    const channelKeys = this.exactByChannel.get(arrival.channelId) ?? new Set<string>()
    if (
      this.exact.size >= MAX_EXACT_ARRIVALS
      || channelKeys.size >= MAX_EXACT_ARRIVALS_PER_CHANNEL
    ) {
      const foldedFamilies = new Set(families)
      let isMention = arrival.isMention === true
      let serverId = arrival.serverId
      let railChannelId = arrival.railChannelId
      for (const exactKey of [...channelKeys]) {
        const folded = this.exact.get(exactKey)!
        for (const family of folded.families) foldedFamilies.add(family)
        isMention ||= folded.isMention
        serverId ??= folded.serverId
        railChannelId ??= folded.railChannelId
        this.removeExact(exactKey)
      }
      this.recordSticky(
        arrival.channelId,
        [...foldedFamilies],
        isMention,
        serverId,
        railChannelId,
      )
      return
    }
    const pending: PendingArrival = {
      key,
      channelId: arrival.channelId,
      serverId: arrival.serverId,
      railChannelId: arrival.railChannelId,
      seq: seq!,
      ordinal: ++this.ordinal,
      isMention: arrival.isMention === true,
      families: new Set(families),
    }
    this.exact.set(key, pending)
    channelKeys.add(key)
    this.exactByChannel.set(arrival.channelId, channelKeys)
    this.publish()
  }

  recordRead(channelId: string, seq: number) {
    if (!Number.isSafeInteger(seq) || seq <= 0) return
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
    if (!Number.isSafeInteger(seq) || seq <= 0) return
    this.optimisticReads.set(generation, { channelId, seq, committed: false })
    this.publish()
  }

  settleOptimisticRead(
    generation: number,
    committed: boolean,
    confirmedSeq?: number,
  ) {
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
        for (const [key, arrival] of this.exact) {
          if (arrival.ordinal > fence.ordinal) continue
          for (const family of [...arrival.families]) {
            if (arrivalDomain(family, arrival.serverId) === domain) {
              arrival.families.delete(family)
            }
          }
          if (arrival.families.size === 0) this.removeExact(key)
        }
        for (const [channelId, unknown] of this.sticky) {
          for (const [family, pending] of [...unknown.families]) {
            if (
              pending.ordinal <= fence.ordinal
              && arrivalDomain(family, unknown.serverId) === domain
            ) {
              unknown.families.delete(family)
            }
          }
          if (unknown.families.size === 0) this.sticky.delete(channelId)
        }
        this.markAll.delete(domain)
        for (const [key, sentinel] of this.sentinels) {
          if (sentinel.ordinal <= fence.ordinal && key.endsWith(`\u0000${domain}`)) {
            this.sentinels.delete(key)
          }
        }
        changed = true
      }
    }
    if (changed) this.publish()
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
    if (options.stale) return
    const byChannel = new Map(sources.map((source) => [source.channelId, source]))
    let changed = false
    for (const source of sources) {
      if (source.lastUnreadSeq > 0) {
        const evidenceKey = this.evidenceKey(family, source.channelId)
        this.evidence.set(
          evidenceKey,
          Math.max(this.evidence.get(evidenceKey) ?? 0, source.lastUnreadSeq),
        )
      }
    }
    for (const [key, arrival] of this.exact) {
      if (!arrival.families.has(family)) continue
      const source = byChannel.get(arrival.channelId)
      const evidenceSeq = family === "inbox-mentions"
        ? source?.lastMentionSeq ?? source?.lastUnreadSeq
        : source?.lastUnreadSeq
      if (evidenceSeq !== undefined && evidenceSeq !== null && evidenceSeq >= arrival.seq) {
        arrival.families.delete(family)
        changed = true
        if (arrival.families.size === 0) this.removeExact(key)
      }
    }
    for (const [channelId, unknown] of this.sticky) {
      const pending = unknown.families.get(family)
      if (!pending) continue
      const source = byChannel.get(channelId)
      const evidenceSeq = family === "inbox-mentions"
        ? source?.lastMentionSeq ?? source?.lastUnreadSeq
        : source?.lastUnreadSeq
      if (evidenceSeq !== undefined && evidenceSeq !== null && evidenceSeq > pending.boundary) {
        unknown.families.delete(family)
        changed = true
        if (unknown.families.size === 0) this.sticky.delete(channelId)
      }
    }
    if (!options.truncated) {
      const key = sentinelKey(family, options.domain ?? familyDomain(family))
      const sentinel = this.sentinels.get(key)
      if (
        sentinel?.witnessChannelId
        && sentinel.witnessFamily === family
      ) {
        const source = byChannel.get(sentinel.witnessChannelId)
        const evidenceSeq = family === "inbox-mentions"
          ? source?.lastMentionSeq ?? source?.lastUnreadSeq
          : source?.lastUnreadSeq
        if (evidenceSeq !== undefined && evidenceSeq !== null && evidenceSeq > sentinel.boundary) {
          changed = this.sentinels.delete(key) || changed
        }
      }
    }
    if (changed) this.publish()
  }

  projectUnread(
    family: AccountUnreadFamily,
    channelId: string,
    rawUnread: boolean,
    sourceSeq?: number | null,
    domain: AccountUnreadDomain = familyDomain(family),
  ) {
    const fence = this.markAll.get(domain)
    const read = this.effectiveReadSeq(channelId)
    const rawVisible = rawUnread
      && !(sourceSeq && read >= sourceSeq)
      && !fence
    if (rawVisible) return true
    const sentinel = this.sentinels.get(sentinelKey(family, domain))
    if (sentinel && (!fence || sentinel.ordinal > fence.ordinal)) return true
    for (const key of this.exactByChannel.get(channelId) ?? []) {
      const arrival = this.exact.get(key)
      if (!arrival || !arrival.families.has(family) || arrival.seq <= read) continue
      if (!fence || arrival.ordinal > fence.ordinal) return true
    }
    const sticky = this.sticky.get(channelId)
    const pending = sticky?.families.get(family)
    if (pending) {
      if (!fence || pending.ordinal > fence.ordinal) return true
    }
    return false
  }

  projectMentionCount(
    family: "servers" | "inbox-mentions",
    channelId: string,
    rawCount: number,
    sourceSeq?: number | null,
  ) {
    const fence = this.markAll.get("mentions")
    const read = this.effectiveReadSeq(channelId)
    let count = !fence && !(sourceSeq && read >= sourceSeq) ? rawCount : 0
    for (const key of this.exactByChannel.get(channelId) ?? []) {
      const arrival = this.exact.get(key)
      if (
        family === "inbox-mentions"
        && arrival?.isMention
        && arrival.families.has(family)
        && arrival.seq > read
        && !(sourceSeq && sourceSeq >= arrival.seq)
        && (!fence || arrival.ordinal > fence.ordinal)
      ) count += 1
    }
    return count
  }

  projectServerUnread(
    serverId: string,
    sources: readonly AccountUnreadSource[],
    rawUnread = false,
  ) {
    if (sources.some((source) => this.projectUnread(
      "servers",
      source.channelId,
      true,
      source.lastUnreadSeq,
    ))) return true
    if (rawUnread && sources.length === 0 && !this.markAll.get("channels")) return true
    const sentinel = this.sentinels.get(sentinelKey("servers", "channels"))
    const fence = this.markAll.get("channels")
    if (sentinel && (!fence || sentinel.ordinal > fence.ordinal)) return true
    for (const arrival of this.exact.values()) {
      if (
        arrival.serverId === serverId
        && this.projectUnread("servers", arrival.channelId, false)
      ) return true
    }
    for (const unknown of this.sticky.values()) {
      if (
        unknown.serverId === serverId
        && this.projectUnread("servers", unknown.channelId, false)
      ) return true
    }
    return false
  }

  projectServerChannelUnread(
    serverId: string,
    channelId: string,
    sources: readonly AccountUnreadSource[],
    rawUnread = false,
  ) {
    const family = `server-detail:${serverId}` as const
    if (sources.some((source) => this.projectUnread(
      family,
      source.channelId,
      true,
      source.lastUnreadSeq,
    ))) return true
    if (rawUnread && sources.length === 0 && !this.markAll.get("channels")) return true
    const sentinel = this.sentinels.get(sentinelKey(family, "channels"))
    const fence = this.markAll.get("channels")
    if (sentinel && (!fence || sentinel.ordinal > fence.ordinal)) return true
    for (const arrival of this.exact.values()) {
      if (
        arrival.serverId === serverId
        && (arrival.channelId === channelId || arrival.railChannelId === channelId)
        && this.projectUnread(family, arrival.channelId, false)
      ) return true
    }
    for (const unknown of this.sticky.values()) {
      if (
        unknown.serverId === serverId
        && (unknown.channelId === channelId || unknown.railChannelId === channelId)
        && this.projectUnread(family, unknown.channelId, false)
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
  ) {
    const family = `server-detail:${serverId}` as const
    if (this.projectUnread(family, parentChannelId, rawBaseUnread, sourceSeq)) return true
    for (const arrival of this.exact.values()) {
      if (
        arrival.serverId === serverId
        && arrival.railChannelId === parentChannelId
        && !renderedChildIds.has(arrival.channelId)
        && this.projectUnread(family, arrival.channelId, false)
      ) return true
    }
    for (const unknown of this.sticky.values()) {
      if (
        unknown.serverId === serverId
        && unknown.railChannelId === parentChannelId
        && !renderedChildIds.has(unknown.channelId)
        && this.projectUnread(family, unknown.channelId, false)
      ) return true
    }
    return false
  }

  projectServerMentionCount(
    _serverId: string,
    sources: ReadonlyArray<{ channelId: string; count: number; lastSeq: number }>,
    rawFallback = 0,
  ) {
    return sources.length === 0 && !this.markAll.get("mentions")
      ? rawFallback
      : sources.reduce((sum, source) => sum + this.projectMentionCount(
      "servers",
      source.channelId,
      source.count,
      source.lastSeq,
    ), 0)
  }

  hasPending(family?: AccountUnreadFamily, domain?: AccountUnreadDomain) {
    if (family && domain) {
      const sentinel = this.sentinels.get(sentinelKey(family, domain))
      const fence = this.markAll.get(domain)
      if (sentinel && (!fence || sentinel.ordinal > fence.ordinal)) return true
    }
    if (family && !domain) {
      const prefix = `${sentinelFamily(family)}\u0000`
      for (const [key, sentinel] of this.sentinels) {
        if (!key.startsWith(prefix)) continue
        const sentinelDomain = key.slice(prefix.length) as AccountUnreadDomain
        const fence = this.markAll.get(sentinelDomain)
        if (!fence || sentinel.ordinal > fence.ordinal) return true
      }
    }
    for (const arrival of this.exact.values()) {
      if (family && !arrival.families.has(family)) continue
      const arrivalDomain = family === "inbox-mentions" || arrival.isMention && domain === "mentions"
        ? "mentions"
        : arrival.serverId ? "channels" : "dms"
      if (domain && arrivalDomain !== domain) continue
      const fence = this.markAll.get(domain ?? arrivalDomain)
      if (!fence || arrival.ordinal > fence.ordinal) return true
    }
    for (const unknown of this.sticky.values()) {
      for (const [pendingFamily, pending] of unknown.families) {
        if (family && pendingFamily !== family) continue
        const pendingDomain = arrivalDomain(pendingFamily, unknown.serverId)
        if (domain && pendingDomain !== domain) continue
        const fence = this.markAll.get(domain ?? pendingDomain)
        if (!fence || pending.ordinal > fence.ordinal) return true
      }
    }
    return false
  }

  beginMarkAll(domain: AccountUnreadDomain): MarkAllToken {
    const token: MarkAllToken = { domain, ordinal: this.ordinal, nonce: Symbol(domain) }
    this.markAll.set(domain, { ...token, state: "pending", revision: null })
    this.publish()
    return token
  }

  commitMarkAll(token: MarkAllToken, revision: number) {
    const fence = this.markAll.get(token.domain)
    if (!fence || fence.nonce !== token.nonce) return
    fence.state = "committed"
    fence.revision = revision
    this.publish()
  }

  rollbackMarkAll(token: MarkAllToken) {
    const fence = this.markAll.get(token.domain)
    if (!fence || fence.nonce !== token.nonce) return
    this.markAll.delete(token.domain)
    this.publish()
  }

  private recordSticky(
    channelId: string,
    families: AccountUnreadFamily[],
    isMention: boolean,
    serverId?: string,
    railChannelId?: string,
  ) {
    const arrivalOrdinal = ++this.ordinal
    let unknown = this.sticky.get(channelId)
    if (!unknown) {
      if (this.sticky.size >= MAX_STICKY_SCOPES) {
        for (const family of families) {
          const key = sentinelKey(family, arrivalDomain(family, serverId))
          const existing = this.sentinels.get(key)
          if (existing) {
            existing.ordinal = arrivalOrdinal
            if (
              existing.witnessChannelId !== channelId
              || existing.witnessFamily !== family
            ) {
              existing.witnessChannelId = null
              existing.witnessFamily = null
            }
          } else {
            this.sentinels.set(key, {
              ordinal: arrivalOrdinal,
              witnessChannelId: channelId,
              witnessFamily: family,
              boundary: this.evidence.get(this.evidenceKey(family, channelId)) ?? 0,
            })
          }
        }
        this.publish()
        return
      }
      unknown = {
        channelId,
        serverId,
        railChannelId,
        isMention,
        families: new Map(),
      }
      this.sticky.set(channelId, unknown)
    }
    unknown.isMention ||= isMention
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
  if (ownerUserId) byUser.delete(ownerUserId)
  else byUser.clear()
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
