"use client"

import type { QueryClient } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api/client"
import { ApiError } from "@/lib/errors"
import { communityKeys } from "@/lib/query-keys"
import { reconcileAccountReadState } from "./community-ws/read-state-reconciliation"
import {
  projectReadCoordinatorSnapshot as projectRegisteredReadCoordinatorSnapshot,
  registerReadCoordinatorSnapshotProjector,
  type ReadCoordinatorSnapshot,
  unregisterReadCoordinatorSnapshotProjector,
} from "./read-coordinator-snapshot-projection"

export const READ_COORDINATOR_DEBOUNCE_MS = 500

type TimelineReadIntent = {
  kind: "timeline"
  channelId: string
  messageId: string
  seq: number
}

type ForumOpenerReadIntent = {
  kind: "forum-opener"
  openerMessageId: string
  parentChannelId: string
  parentSeq: number
}

export type ReadIntent = TimelineReadIntent | ForumOpenerReadIntent

export type ReadSurface =
  | { kind: "timeline"; channelId: string }
  | {
      kind: "forum-opener"
      openerMessageId: string
      parentChannelId: string
      parentSeq: number
    }

type ReadMutationResponse = {
  changed: boolean
  revision: number
  targetSeq?: number
  openerMessageId?: string
}

type SurfaceLease = {
  coordinator: ReadCoordinator
  key: string
  token: symbol
  epoch: number
}

type ScopeState = {
  surface: ReadSurface
  epoch: number
  leases: Set<symbol>
  releaseTimer: ReturnType<typeof setTimeout> | null
  timer: ReturnType<typeof setTimeout> | null
  retryTimer: ReturnType<typeof setTimeout> | null
  accepted: ReadIntent | null
  dirty: ReadIntent | null
  inFlight: {
    target: ReadIntent
    controller: AbortController
    attemptEpoch: number
  } | null
  attemptEpoch: number
  retryCount: number
  confirmedSeq: number
  confirmedOpener: boolean
}

const coordinators = new WeakMap<QueryClient, ReadCoordinator>()
const disposedClients = new WeakSet<QueryClient>()

function scopeKey(surface: ReadSurface) {
  return surface.kind === "timeline"
    ? `timeline:${surface.channelId}`
    : `forum-opener:${surface.openerMessageId}`
}

function sameIntent(left: ReadIntent, right: ReadIntent) {
  if (left.kind !== right.kind) return false
  return left.kind === "timeline"
    ? left.channelId === (right as TimelineReadIntent).channelId
      && left.seq === (right as TimelineReadIntent).seq
    : left.openerMessageId === (right as ForumOpenerReadIntent).openerMessageId
}

function laterIntent(current: ReadIntent | null, incoming: ReadIntent) {
  if (!current) return incoming
  if (current.kind !== incoming.kind) return incoming
  if (incoming.kind === "timeline") {
    return incoming.seq > (current as TimelineReadIntent).seq ? incoming : current
  }
  return current
}

function retryable(error: unknown) {
  if (!(error instanceof ApiError)) return true
  return error.status === 0
    || error.status === 408
    || error.status === 429
    || error.status >= 500
}

class ReadCoordinator {
  private readonly states = new Map<string, ScopeState>()
  private disposed = false
  private identityEpoch = 0

  constructor(
    private readonly queryClient: QueryClient,
    readonly ownerUserId: string,
  ) {}

  register(surface: ReadSurface, confirmedSeq = 0): SurfaceLease {
    this.assertActive()
    const key = scopeKey(surface)
    let state = this.states.get(key)
    if (!state) {
      state = {
        surface,
        epoch: 0,
        leases: new Set(),
        releaseTimer: null,
        timer: null,
        retryTimer: null,
        accepted: null,
        dirty: null,
        inFlight: null,
        attemptEpoch: 0,
        retryCount: 0,
        confirmedSeq,
        confirmedOpener: false,
      }
      this.states.set(key, state)
    } else if (surface.kind === "timeline") {
      state.confirmedSeq = Math.max(state.confirmedSeq, confirmedSeq)
    }
    if (state.releaseTimer !== null) {
      clearTimeout(state.releaseTimer)
      state.releaseTimer = null
    }
    const token = Symbol(key)
    state.leases.add(token)
    const cached = this.queryClient.getQueryData<{
      readStates: Array<{ channelId: string; lastReadSeq: number }>
      forumOpenerReads?: Array<{ openerMessageId: string }>
    }>(communityKeys.accountReadStateSnapshot())
    if (cached) this.applySnapshot(cached)
    return { coordinator: this, key, token, epoch: state.epoch }
  }

  release(lease: SurfaceLease) {
    const state = this.validState(lease)
    if (!state) return
    state.leases.delete(lease.token)
    if (state.leases.size > 0 || state.releaseTimer !== null) return
    state.releaseTimer = setTimeout(() => {
      state.releaseTimer = null
      if (state.leases.size > 0 || this.disposed) return
      state.epoch += 1
      this.flush(state)
    }, 0)
  }

  submit(lease: SurfaceLease, intent: ReadIntent) {
    const state = this.validState(lease)
    if (!state || !this.matchesSurface(state.surface, intent)) return false
    if (typeof document !== "undefined" && document.visibilityState !== "visible") {
      return false
    }
    if (this.confirmed(state, intent)) return false
    state.accepted = laterIntent(state.accepted, intent)
    state.dirty = laterIntent(state.dirty, intent)
    this.schedule(state, READ_COORDINATOR_DEBOUNCE_MS)
    return true
  }

  resume() {
    if (this.disposed) return
    for (const state of this.states.values()) {
      if (state.dirty && !this.confirmed(state, state.dirty)) {
        state.accepted = laterIntent(state.accepted, state.dirty)
        state.retryCount = 0
        this.schedule(state, 0)
      }
    }
  }

  applySnapshot(snapshot: {
    readStates: Array<{ channelId: string; lastReadSeq: number }>
    forumOpenerReads?: Array<{ openerMessageId: string }>
  }) {
    if (this.disposed) return
    const seqByChannel = new Map(
      snapshot.readStates.map((row) => [row.channelId, row.lastReadSeq]),
    )
    const sparse = new Set(
      (snapshot.forumOpenerReads ?? []).map((row) => row.openerMessageId),
    )
    for (const state of this.states.values()) {
      if (state.surface.kind === "timeline") {
        state.confirmedSeq = Math.max(
          state.confirmedSeq,
          seqByChannel.get(state.surface.channelId) ?? 0,
        )
      } else {
        state.confirmedOpener = sparse.has(state.surface.openerMessageId)
          || (seqByChannel.get(state.surface.parentChannelId) ?? 0) >= state.surface.parentSeq
      }
      this.cancelConfirmedWork(state)
    }
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.identityEpoch += 1
    for (const state of this.states.values()) {
      if (state.timer !== null) clearTimeout(state.timer)
      if (state.retryTimer !== null) clearTimeout(state.retryTimer)
      if (state.releaseTimer !== null) clearTimeout(state.releaseTimer)
      state.inFlight?.controller.abort()
      state.attemptEpoch += 1
      state.accepted = null
      state.dirty = null
      state.leases.clear()
    }
    this.states.clear()
  }

  private schedule(state: ScopeState, delay: number) {
    if (this.disposed || state.inFlight || state.timer !== null) return
    state.timer = setTimeout(() => {
      state.timer = null
      void this.send(state)
    }, delay)
  }

  private flush(state: ScopeState) {
    if (state.timer !== null) {
      clearTimeout(state.timer)
      state.timer = null
    }
    if (state.accepted && !state.inFlight) void this.send(state)
  }

  private async send(state: ScopeState) {
    if (this.disposed || state.inFlight) return
    const target = state.accepted ?? state.dirty
    /* istanbul ignore next -- reachable transitions cancel an empty target's timer eagerly */
    if (!target || this.confirmed(state, target)) {
      this.cancelConfirmedWork(state)
      return
    }
    state.accepted = null
    const controller = new AbortController()
    const attemptEpoch = ++state.attemptEpoch
    state.inFlight = { target, controller, attemptEpoch }
    const identityEpoch = this.identityEpoch
    try {
      const response = await apiFetch<ReadMutationResponse>(
        target.kind === "timeline"
          ? `/api/community/channels/${target.channelId}/read`
          : `/api/community/messages/${target.openerMessageId}/read`,
        target.kind === "timeline"
          ? {
              method: "PUT",
              body: JSON.stringify({ lastReadMessageId: target.messageId }),
              signal: controller.signal,
            }
          : { method: "PUT", signal: controller.signal },
      )
      if (!this.attemptActive(state, attemptEpoch, identityEpoch)) return
      if (target.kind === "timeline") {
        state.confirmedSeq = Math.max(
          state.confirmedSeq,
          response.targetSeq ?? target.seq,
        )
      } else {
        state.confirmedOpener = true
      }
      state.dirty = sameIntent(state.dirty ?? target, target) ? null : state.dirty
      state.retryCount = 0
      void reconcileAccountReadState(this.queryClient, {
        targetRevision: response.revision,
      }).catch(() => undefined)
    } catch (error) {
      if (!this.attemptActive(state, attemptEpoch, identityEpoch)) return
      if (!retryable(error)) {
        if (state.dirty && sameIntent(state.dirty, target)) state.dirty = null
        state.retryCount = 0
      } else if (state.retryCount < 3) {
        state.retryCount += 1
        state.accepted = laterIntent(state.accepted, target)
        const delay = 250 * 2 ** (state.retryCount - 1)
        state.retryTimer = setTimeout(() => {
          state.retryTimer = null
          this.schedule(state, 0)
        }, delay)
      }
    } finally {
      if (state.inFlight?.attemptEpoch === attemptEpoch) state.inFlight = null
      if (!this.disposed && state.accepted && state.retryTimer === null) {
        this.schedule(state, 0)
      }
    }
  }

  private cancelConfirmedWork(state: ScopeState) {
    if (state.accepted && this.confirmed(state, state.accepted)) state.accepted = null
    if (state.dirty && this.confirmed(state, state.dirty)) state.dirty = null
    if (state.inFlight && this.confirmed(state, state.inFlight.target)) {
      state.attemptEpoch += 1
      state.inFlight.controller.abort()
      state.inFlight = null
    }
    if (!state.accepted && state.timer !== null) {
      clearTimeout(state.timer)
      state.timer = null
    }
    if (!state.dirty && state.retryTimer !== null) {
      clearTimeout(state.retryTimer)
      state.retryTimer = null
    }
  }

  private confirmed(state: ScopeState, intent: ReadIntent) {
    return intent.kind === "timeline"
      ? state.confirmedSeq >= intent.seq
      : state.confirmedOpener
        || (state.surface.kind === "forum-opener"
          && state.confirmedSeq >= state.surface.parentSeq)
  }

  private matchesSurface(surface: ReadSurface, intent: ReadIntent) {
    return surface.kind === intent.kind
      && (surface.kind === "timeline"
        ? surface.channelId === (intent as TimelineReadIntent).channelId
        : surface.openerMessageId === (intent as ForumOpenerReadIntent).openerMessageId)
  }

  private validState(lease: SurfaceLease) {
    if (this.disposed || lease.coordinator !== this) return null
    const state = this.states.get(lease.key)
    if (!state || state.epoch !== lease.epoch || !state.leases.has(lease.token)) return null
    return state
  }

  private attemptActive(
    state: ScopeState,
    attemptEpoch: number,
    identityEpoch: number,
  ) {
    return !this.disposed
      && this.identityEpoch === identityEpoch
      && state.inFlight?.attemptEpoch === attemptEpoch
      && state.attemptEpoch === attemptEpoch
  }

  private assertActive() {
    if (this.disposed) throw new Error("read coordinator disposed")
  }
}

export function getReadCoordinator(
  queryClient: QueryClient,
  ownerUserId: string,
) {
  if (disposedClients.has(queryClient)) throw new Error("read coordinator disposed")
  const current = coordinators.get(queryClient)
  if (current) {
    if (current.ownerUserId !== ownerUserId) {
      throw new Error("read coordinator owner mismatch")
    }
    return current
  }
  const created = new ReadCoordinator(queryClient, ownerUserId)
  coordinators.set(queryClient, created)
  registerReadCoordinatorSnapshotProjector(queryClient, (snapshot) => {
    created.applySnapshot(snapshot)
  })
  return created
}

export function disposeReadCoordinator(queryClient: QueryClient) {
  disposedClients.add(queryClient)
  coordinators.get(queryClient)?.dispose()
  unregisterReadCoordinatorSnapshotProjector(queryClient)
}

export function projectReadCoordinatorSnapshot(
  queryClient: QueryClient,
  snapshot: ReadCoordinatorSnapshot,
) {
  projectRegisteredReadCoordinatorSnapshot(queryClient, snapshot)
}

export function registerReadSurface(
  queryClient: QueryClient,
  ownerUserId: string,
  surface: ReadSurface,
  confirmedSeq = 0,
) {
  return getReadCoordinator(queryClient, ownerUserId).register(surface, confirmedSeq)
}

export function releaseReadSurface(lease: SurfaceLease) {
  lease.coordinator.release(lease)
}

export function submitReadIntent(lease: SurfaceLease, intent: ReadIntent) {
  return lease.coordinator.submit(lease, intent)
}

export function resumeReadCoordinator(queryClient: QueryClient) {
  coordinators.get(queryClient)?.resume()
}
