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
import {
  disposeInboxReadReservation,
  settleInboxReadReservationGeneration,
} from "./inbox-read-reservation"

export const READ_COORDINATOR_DEBOUNCE_MS = 500

export type ReadIntent = {
  kind: "timeline"
  channelId: string
  messageId: string
  seq: number
}

export type ReadSurface = { kind: "timeline"; channelId: string }

type QueuedReadIntent = {
  intent: ReadIntent
  generation: number
  dueAt: number
  ownerToken: symbol
}

export type PendingReadFlushOutcome = {
  consumed: boolean
  cutoff: number | null
  deferred?: true
}

type ReadAttemptOutcome = {
  committed: boolean
  reconciled: boolean
  deferred?: true
}

type PendingReadFlushOptions = {
  deferInboxDms?: () => boolean
}

type ReadMutationResponse = {
  changed: boolean
  revision: number
  targetSeq: number
}

type SurfaceLease = {
  coordinator: ReadCoordinator
  key: string
  token: symbol
  epoch: number
  releasePolicy: "flush" | "cancel-uncommitted"
}

type ScopeState = {
  surface: ReadSurface
  epoch: number
  leases: Set<symbol>
  releaseTimer: ReturnType<typeof setTimeout> | null
  timer: ReturnType<typeof setTimeout> | null
  retryTimer: ReturnType<typeof setTimeout> | null
  accepted: QueuedReadIntent | null
  dirty: QueuedReadIntent | null
  inFlight: {
    target: QueuedReadIntent
    controller: AbortController
    attemptEpoch: number
    phase: "mutation" | "reconciling"
    completion: Promise<ReadAttemptOutcome>
    drainCutoff?: number
    deferInboxDms?: () => boolean
  } | null
  attemptEpoch: number
  retryCount: number
  confirmedSeq: number
}

const coordinators = new WeakMap<QueryClient, ReadCoordinator>()
const disposedClients = new WeakSet<QueryClient>()

function scopeKey(surface: ReadSurface) {
  return `timeline:${surface.channelId}`
}

function sameIntent(left: QueuedReadIntent, right: QueuedReadIntent) {
  return left.intent.channelId === right.intent.channelId
    && left.intent.seq === right.intent.seq
}

function laterIntent(current: QueuedReadIntent | null, incoming: QueuedReadIntent) {
  if (!current) return incoming
  return incoming.intent.seq > current.intent.seq ? incoming : current
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
  private latestIntentGeneration = 0

  constructor(
    private readonly queryClient: QueryClient,
    readonly ownerUserId: string,
  ) {}

  register(
    surface: ReadSurface,
    confirmedSeq = 0,
    releasePolicy: SurfaceLease["releasePolicy"] = "flush",
  ): SurfaceLease {
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
    }>(communityKeys.accountReadStateSnapshot())
    if (cached) this.applySnapshot(cached)
    return { coordinator: this, key, token, epoch: state.epoch, releasePolicy }
  }

  release(lease: SurfaceLease) {
    const state = this.validState(lease)
    if (!state) return
    state.leases.delete(lease.token)
    if (lease.releasePolicy === "cancel-uncommitted") {
      const canceledGenerations = new Set<number>()
      if (state.accepted?.ownerToken === lease.token) {
        canceledGenerations.add(state.accepted.generation)
        state.accepted = null
      }
      if (state.dirty?.ownerToken === lease.token) {
        canceledGenerations.add(state.dirty.generation)
        state.dirty = null
      }
      if (
        state.inFlight?.target.ownerToken === lease.token
        && state.inFlight.phase === "mutation"
      ) {
        canceledGenerations.add(state.inFlight.target.generation)
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
      for (const generation of canceledGenerations) {
        void settleInboxReadReservationGeneration(
          this.queryClient,
          generation,
          false,
          state.surface.channelId,
        )
      }
      return
    }
    if (state.leases.size > 0 || state.releaseTimer !== null) return
    state.releaseTimer = setTimeout(() => {
      state.releaseTimer = null
      if (state.leases.size > 0 || this.disposed) return
      state.epoch += 1
      this.flush(state)
    }, 0)
  }

  submit(lease: SurfaceLease, intent: ReadIntent): number | null {
    const state = this.validState(lease)
    if (!state || !this.matchesSurface(state.surface, intent)) return null
    if (typeof document !== "undefined" && document.visibilityState !== "visible") {
      return null
    }
    if (this.confirmed(state, intent)) return null
    const queued = {
      intent,
      generation: ++this.latestIntentGeneration,
      dueAt: Date.now() + READ_COORDINATOR_DEBOUNCE_MS,
      ownerToken: lease.token,
    }
    state.accepted = laterIntent(state.accepted, queued)
    state.dirty = laterIntent(state.dirty, queued)
    this.schedule(state, READ_COORDINATOR_DEBOUNCE_MS)
    return queued.generation
  }

  confirm(lease: SurfaceLease, confirmedSeq: number) {
    const state = this.validState(lease)
    if (!state) return
    state.confirmedSeq = Math.max(state.confirmedSeq, confirmedSeq)
    this.cancelConfirmedWork(state)
  }

  resume() {
    if (this.disposed) return
    for (const state of this.states.values()) {
      if (state.dirty && !this.confirmed(state, state.dirty.intent)) {
        state.accepted = laterIntent(state.accepted, state.dirty)
        state.retryCount = 0
        this.schedule(state, 0)
      }
    }
  }

  applySnapshot(snapshot: {
    readStates: Array<{ channelId: string; lastReadSeq: number }>
  }) {
    if (this.disposed) return
    const seqByChannel = new Map(
      snapshot.readStates.map((row) => [row.channelId, row.lastReadSeq]),
    )
    for (const state of this.states.values()) {
      state.confirmedSeq = Math.max(
        state.confirmedSeq,
        seqByChannel.get(state.surface.channelId) ?? 0,
      )
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
      void this.startSend(state)
    }, delay)
  }

  private flush(state: ScopeState) {
    if (state.timer !== null) {
      clearTimeout(state.timer)
      state.timer = null
    }
    if (state.accepted && !state.inFlight) void this.startSend(state)
  }

  async flushPending(
    options: PendingReadFlushOptions = {},
  ): Promise<PendingReadFlushOutcome> {
    if (this.disposed || this.latestIntentGeneration === 0) {
      return { consumed: false, cutoff: null }
    }
    const cutoff = this.latestIntentGeneration
    const results = await Promise.all(
      [...this.states.values()].map((state) => this.flushState(state, cutoff, options)),
    )
    const eligible = results.filter((result) => result.eligible)
    const settled = eligible.length > 0
      && eligible.every((result) => result.consumed || result.deferred)
    const consumed = eligible.length > 0
      && eligible.every((result) => result.consumed)
    return {
      consumed,
      cutoff,
      ...(settled && !consumed ? { deferred: true as const } : {}),
    }
  }

  private async flushState(
    state: ScopeState,
    cutoff: number,
    options: PendingReadFlushOptions,
  ) {
    let eligible = false
    let deferred = false
    while (!this.disposed) {
      const active = state.inFlight
      if (active) {
        if (active.target.generation > cutoff) break
        active.drainCutoff = Math.max(active.drainCutoff ?? cutoff, cutoff)
        if (options.deferInboxDms) active.deferInboxDms = options.deferInboxDms
        eligible = true
        const outcome = await active.completion
        if (!outcome.committed || (!outcome.reconciled && !outcome.deferred)) {
          return { eligible, consumed: false }
        }
        deferred ||= outcome.deferred === true
        continue
      }

      const target = state.accepted ?? state.dirty
      if (!target || target.generation > cutoff) break
      eligible = true
      if (state.retryTimer !== null) return { eligible, consumed: false }
      if (state.timer !== null) {
        clearTimeout(state.timer)
        state.timer = null
      }
      const outcome = await this.startSend(state, cutoff, options)
      if (!outcome.committed || (!outcome.reconciled && !outcome.deferred)) {
        return { eligible, consumed: false }
      }
      deferred ||= outcome.deferred === true
    }
    return { eligible, consumed: eligible && !deferred, deferred }
  }

  private startSend(
    state: ScopeState,
    drainCutoff?: number,
    options: PendingReadFlushOptions = {},
  ): Promise<ReadAttemptOutcome> {
    /* istanbul ignore next -- private callers synchronously gate disposal before entry */
    if (this.disposed) {
      return Promise.resolve({ committed: false, reconciled: false })
    }
    if (state.inFlight) return state.inFlight.completion
    const target = state.accepted ?? state.dirty
    /* istanbul ignore next -- reachable transitions cancel an empty target's timer eagerly */
    if (!target || this.confirmed(state, target.intent)) {
      this.cancelConfirmedWork(state)
      return Promise.resolve({ committed: false, reconciled: false })
    }
    state.accepted = null
    const controller = new AbortController()
    const attemptEpoch = ++state.attemptEpoch
    let resolveCompletion!: (outcome: ReadAttemptOutcome) => void
    const completion = new Promise<ReadAttemptOutcome>((resolve) => {
      resolveCompletion = resolve
    })
    state.inFlight = {
      target,
      controller,
      attemptEpoch,
      phase: "mutation",
      completion,
      drainCutoff,
      deferInboxDms: options.deferInboxDms,
    }
    void this.performSend(state, target, controller, attemptEpoch)
      .then(resolveCompletion)
    return completion
  }

  private async performSend(
    state: ScopeState,
    target: QueuedReadIntent,
    controller: AbortController,
    attemptEpoch: number,
  ): Promise<ReadAttemptOutcome> {
    const identityEpoch = this.identityEpoch
    let response: ReadMutationResponse
    try {
      response = await apiFetch<ReadMutationResponse>(
        `/api/community/channels/${target.intent.channelId}/read`,
        {
          method: "PUT",
          body: JSON.stringify({ lastReadMessageId: target.intent.messageId }),
          signal: controller.signal,
        },
      )
    } catch (error) {
      if (!this.attemptActive(state, attemptEpoch, identityEpoch)) {
        return { committed: false, reconciled: false }
      }
      await settleInboxReadReservationGeneration(
        this.queryClient,
        target.generation,
        false,
        target.intent.channelId,
      )
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
      this.finishAttempt(state, attemptEpoch)
      return { committed: false, reconciled: false }
    }

    if (!this.attemptActive(state, attemptEpoch, identityEpoch)) {
      return { committed: false, reconciled: false }
    }
    await settleInboxReadReservationGeneration(
      this.queryClient,
      target.generation,
      true,
      target.intent.channelId,
    )
    if (!this.attemptActive(state, attemptEpoch, identityEpoch)) {
      return { committed: false, reconciled: false }
    }
    state.confirmedSeq = Math.max(state.confirmedSeq, response.targetSeq)
    state.dirty = sameIntent(state.dirty ?? target, target) ? null : state.dirty
    state.retryCount = 0
    if (state.inFlight?.attemptEpoch === attemptEpoch) {
      state.inFlight.phase = "reconciling"
    }
    const activeAttempt = state.inFlight?.attemptEpoch === attemptEpoch
      ? state.inFlight
      /* istanbul ignore next -- attemptActive succeeded and no write or await can replace inFlight */
      : null
    const deferInboxDms = activeAttempt?.deferInboxDms?.() === true
      || (activeAttempt?.drainCutoff !== undefined
        && state.accepted !== null
        && state.accepted.generation > activeAttempt.drainCutoff)
    try {
      await reconcileAccountReadState(this.queryClient, {
        surfaceMode: deferInboxDms ? "non-inbox" : "all",
        awaitSurfaceMode: deferInboxDms ? "none" : "inbox-dms",
        targetRevision: response.revision,
      })
      if (deferInboxDms) {
        return {
          committed: true,
          reconciled: false,
          deferred: true,
        }
      }
      return {
        committed: true,
        reconciled: this.attemptActive(state, attemptEpoch, identityEpoch),
      }
    } catch {
      return { committed: true, reconciled: false }
    } finally {
      this.finishAttempt(state, attemptEpoch)
    }
  }

  private finishAttempt(
    state: ScopeState,
    attemptEpoch: number,
  ) {
    const drainCutoff = state.inFlight?.attemptEpoch === attemptEpoch
      ? state.inFlight.drainCutoff
      /* istanbul ignore next -- this reconciliation finally is the attempt's only finisher */
      : undefined
    if (state.inFlight?.attemptEpoch === attemptEpoch) state.inFlight = null
    if (this.disposed || !state.accepted || state.retryTimer !== null) return
    if (
      drainCutoff !== undefined
      && state.accepted.generation <= drainCutoff
    ) {
      this.schedule(state, 0)
      return
    }
    this.schedule(state, Math.max(0, state.accepted.dueAt - Date.now()))
  }

  private cancelConfirmedWork(state: ScopeState) {
    if (state.accepted && this.confirmed(state, state.accepted.intent)) state.accepted = null
    if (state.dirty && this.confirmed(state, state.dirty.intent)) state.dirty = null
    if (
      state.inFlight
      && state.inFlight.phase === "mutation"
      && this.confirmed(state, state.inFlight.target.intent)
    ) {
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
    return state.confirmedSeq >= intent.seq
  }

  private matchesSurface(surface: ReadSurface, intent: ReadIntent) {
    return surface.channelId === intent.channelId
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
  disposeInboxReadReservation(queryClient)
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
  releasePolicy: SurfaceLease["releasePolicy"] = "flush",
) {
  return getReadCoordinator(queryClient, ownerUserId).register(
    surface,
    confirmedSeq,
    releasePolicy,
  )
}

export function releaseReadSurface(lease: SurfaceLease) {
  lease.coordinator.release(lease)
}

export function confirmReadSurface(lease: SurfaceLease, confirmedSeq: number) {
  lease.coordinator.confirm(lease, confirmedSeq)
}

export function submitReadIntent(lease: SurfaceLease, intent: ReadIntent) {
  return lease.coordinator.submit(lease, intent) !== null
}

export function submitReadIntentGeneration(lease: SurfaceLease, intent: ReadIntent) {
  return lease.coordinator.submit(lease, intent)
}

export function flushPendingReadIntents(
  queryClient: QueryClient,
  options?: PendingReadFlushOptions,
): Promise<PendingReadFlushOutcome> {
  const coordinator = coordinators.get(queryClient)
  if (!coordinator) return Promise.resolve({ consumed: false, cutoff: null })
  return coordinator.flushPending(options)
}

export function resumeReadCoordinator(queryClient: QueryClient) {
  coordinators.get(queryClient)?.resume()
}
