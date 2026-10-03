"use client"

import { createStore } from "@tanstack/react-store"
import type { Mutation, QueryClient } from "@tanstack/react-query"
import { communityRequestOptions } from "@/lib/community-db/sync"
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
  publishInboxProjectionGenerationTerminal,
  settleInboxReadReservationGeneration,
} from "./inbox-read-reservation"
import { getAccountUnreadProjection } from "./account-unread-projection"
import { getCommunityDbRegistry, type CommunityDbRegistry } from "@/lib/community-db/collections"
import {
  clearAttentionScopeOptimistically,
  commitAttentionScopeOptimisticSnapshot,
  hasAttentionScopeOptimisticFence,
  restoreAttentionScopeOptimisticSnapshot,
  type AttentionScopeOptimisticSnapshot,
} from "@/lib/community-db/sync"
import { reconcileAccountAttention } from "./use-account-attention"

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
  request: ReturnType<typeof communityRequestOptions>
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
  accepted: QueuedReadIntent | null
  dirty: QueuedReadIntent | null
  inFlight: {
    target: QueuedReadIntent
    controller: AbortController
    attemptEpoch: number
    phase: "mutation" | "reconciling"
    completion: Promise<ReadAttemptOutcome>
    mutation: Mutation<ReadMutationResponse, Error, void, unknown>
    drainCutoff?: number
    deferInboxDms?: () => boolean
  } | null
  attemptEpoch: number
  confirmedSeq: number
  attentionOptimistic: {
    registry: CommunityDbRegistry
    snapshot: AttentionScopeOptimisticSnapshot
  } | null
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
  readonly state = createStore({
    scopes: new Map<string, ScopeState>(),
    disposed: false,
    identityEpoch: 0,
    latestIntentGeneration: 0,
  })

  constructor(private readonly queryClient: QueryClient, readonly ownerUserId: string) {}

  private get disposed() { return this.state.get().disposed }
  private get latestIntentGeneration() { return this.state.get().latestIntentGeneration }
  private scope(key: string) { return this.state.get().scopes.get(key) }
  private update(key: string, change: (state: ScopeState) => ScopeState) {
    this.state.setState((state) => {
      const previous = state.scopes.get(key)
      if (!previous) return state
      const next = change(previous)
      return next === previous ? state : { ...state, scopes: new Map(state.scopes).set(key, next) }
    })
  }

  register(surface: ReadSurface, confirmedSeq: number, releasePolicy: SurfaceLease["releasePolicy"]): SurfaceLease {
    this.assertActive()
    const key = scopeKey(surface), token = Symbol(key), current = this.scope(key)
    if (current?.releaseTimer !== null && current?.releaseTimer !== undefined) clearTimeout(current.releaseTimer)
    const state: ScopeState = current
      ? { ...current, confirmedSeq: Math.max(current.confirmedSeq, confirmedSeq), releaseTimer: null, leases: new Set([...current.leases, token]) }
      : { surface: { ...surface }, epoch: 0, leases: new Set([token]), releaseTimer: null, timer: null, accepted: null, dirty: null, inFlight: null, attemptEpoch: 0, confirmedSeq, attentionOptimistic: null }
    this.state.setState((owner) => ({ ...owner, scopes: new Map(owner.scopes).set(key, state) }))
    const cached = this.queryClient.getQueryData<ReadCoordinatorSnapshot>(communityKeys.accountReadStateSnapshot())
    if (cached) this.applySnapshot(cached)
    return { coordinator: this, key, token, epoch: state.epoch, releasePolicy }
  }

  release(lease: SurfaceLease) {
    const state = this.validState(lease)
    if (!state) return
    const leases = new Set(state.leases)
    leases.delete(lease.token)
    this.update(lease.key, (current) => ({ ...current, leases }))
    if (lease.releasePolicy === "cancel-uncommitted") {
      const canceled = new Set<number>()
      const current = this.scope(lease.key)!
      const accepted = current.accepted?.ownerToken === lease.token ? null : current.accepted
      const dirty = current.dirty?.ownerToken === lease.token ? null : current.dirty
      if (current.accepted && !accepted) canceled.add(current.accepted.generation)
      if (current.dirty && !dirty) canceled.add(current.dirty.generation)
      const cancelFlight = current.inFlight?.target.ownerToken === lease.token && current.inFlight.phase === "mutation"
      if (cancelFlight) canceled.add(current.inFlight!.target.generation)
      this.update(lease.key, (scope) => ({ ...scope, accepted, dirty, ...(cancelFlight ? { attemptEpoch: scope.attemptEpoch + 1, inFlight: null } : {}) }))
      if (cancelFlight) current.inFlight!.controller.abort()
      const remaining = this.scope(lease.key)!
      if (!remaining.accepted && remaining.timer !== null) {
        clearTimeout(remaining.timer)
        this.update(lease.key, (scope) => ({ ...scope, timer: null }))
      }
      for (const generation of canceled) {
        getAccountUnreadProjection(this.queryClient, this.ownerUserId).settleOptimisticRead(generation, false)
        void settleInboxReadReservationGeneration(this.queryClient, generation, false, state.surface.channelId).catch(() => undefined)
      }
      if (!remaining.accepted && !remaining.dirty && !remaining.inFlight) this.rollbackAttentionOptimisticRead(lease.key)
      return
    }
    if (leases.size || this.scope(lease.key)?.releaseTimer !== null) return
    const timer = setTimeout(() => {
      const current = this.scope(lease.key)
      if (!current) return
      this.update(lease.key, (scope) => ({ ...scope, releaseTimer: null }))
      if (current.leases.size || this.disposed) return
      this.update(lease.key, (scope) => ({ ...scope, epoch: scope.epoch + 1 }))
      this.flush(lease.key)
    }, 0)
    this.update(lease.key, (scope) => ({ ...scope, releaseTimer: timer }))
  }

  submit(lease: SurfaceLease, intent: ReadIntent): number | null {
    const state = this.validState(lease)
    if (!state || state.surface.channelId !== intent.channelId || state.confirmedSeq >= intent.seq) return null
    if (typeof document !== "undefined" && document.visibilityState !== "visible") return null
    if (Math.max(state.accepted?.intent.seq ?? 0, state.dirty?.intent.seq ?? 0, state.inFlight?.target.intent.seq ?? 0) >= intent.seq) return null
    const superseded = [state.accepted, state.dirty].filter((pending) => pending && pending.intent.seq < intent.seq && pending.generation !== state.inFlight?.target.generation)
    const generation = this.latestIntentGeneration + 1
    const queued: QueuedReadIntent = { intent: { ...intent }, generation, dueAt: Date.now() + READ_COORDINATOR_DEBOUNCE_MS, ownerToken: lease.token, request: communityRequestOptions(this.queryClient) }
    queued.request.assertActive()
    this.state.setState((owner) => ({ ...owner, latestIntentGeneration: generation }))
    this.update(lease.key, (scope) => ({ ...scope, accepted: laterIntent(scope.accepted, queued), dirty: laterIntent(scope.dirty, queued) }))
    this.beginAttentionOptimisticRead(lease.key)
    for (const pending of superseded) getAccountUnreadProjection(this.queryClient, this.ownerUserId).settleOptimisticRead(pending!.generation, false)
    this.schedule(lease.key, READ_COORDINATOR_DEBOUNCE_MS)
    return generation
  }

  confirm(lease: SurfaceLease, confirmedSeq: number) {
    if (!this.validState(lease)) return
    this.update(lease.key, (scope) => ({ ...scope, confirmedSeq: Math.max(scope.confirmedSeq, confirmedSeq) }))
    this.cancelConfirmedWork(lease.key)
  }

  resume() {
    if (this.disposed) return
    for (const [key, scope] of this.state.get().scopes) {
      if (!scope.dirty || scope.confirmedSeq >= scope.dirty.intent.seq) continue
      this.update(key, (current) => ({ ...current, accepted: laterIntent(current.accepted, current.dirty!) }))
      this.schedule(key, 0)
    }
  }

  applySnapshot(snapshot: ReadCoordinatorSnapshot) {
    if (this.disposed) return
    const byChannel = new Map(snapshot.readStates.map((row) => [row.channelId, row.lastReadSeq]))
    for (const [key, scope] of this.state.get().scopes) {
      this.update(key, (current) => ({ ...current, confirmedSeq: Math.max(current.confirmedSeq, byChannel.get(scope.surface.channelId) ?? 0) }))
      this.cancelConfirmedWork(key)
    }
  }

  dispose() {
    if (this.disposed) return
    const scopes = this.state.get().scopes
    this.state.setState((owner) => ({ ...owner, disposed: true, identityEpoch: owner.identityEpoch + 1, scopes: new Map() }))
    for (const scope of scopes.values()) {
      if (scope.timer !== null) clearTimeout(scope.timer)
      if (scope.releaseTimer !== null) clearTimeout(scope.releaseTimer)
      scope.inFlight?.controller.abort()
      if (scope.attentionOptimistic) commitAttentionScopeOptimisticSnapshot(scope.attentionOptimistic.registry, scope.attentionOptimistic.snapshot)
    }
  }

  private schedule(key: string, delay: number) {
    const scope = this.scope(key)
    if (this.disposed || !scope || scope.inFlight || scope.timer !== null) return
    const timer = setTimeout(() => {
      this.update(key, (current) => ({ ...current, timer: null }))
      void this.startSend(key).catch(() => undefined)
    }, delay)
    this.update(key, (current) => ({ ...current, timer }))
  }

  private flush(key: string) {
    const scope = this.scope(key)
    if (!scope) return
    if (scope.timer !== null) {
      clearTimeout(scope.timer)
      this.update(key, (current) => ({ ...current, timer: null }))
    }
    if (scope.accepted && !scope.inFlight) void this.startSend(key).catch(() => undefined)
  }

  async flushPending(options: PendingReadFlushOptions = {}): Promise<PendingReadFlushOutcome> {
    if (this.disposed || this.latestIntentGeneration === 0) return { consumed: false, cutoff: null }
    const cutoff = this.latestIntentGeneration
    const results = await Promise.all([...this.state.get().scopes.keys()].map((key) => this.flushState(key, cutoff, options)))
    const eligible = results.filter((result) => result.eligible)
    const settled = eligible.length > 0 && eligible.every((result) => result.consumed || result.deferred)
    const consumed = eligible.length > 0 && eligible.every((result) => result.consumed)
    return { consumed, cutoff, ...(settled && !consumed ? { deferred: true as const } : {}) }
  }

  private async flushState(key: string, cutoff: number, options: PendingReadFlushOptions) {
    let eligible = false, deferred = false
    while (!this.disposed) {
      const scope = this.scope(key)
      if (!scope) break
      const active = scope.inFlight
      if (active) {
        if (active.target.generation > cutoff) break
        this.update(key, (current) => ({ ...current, inFlight: current.inFlight ? { ...current.inFlight, drainCutoff: Math.max(current.inFlight.drainCutoff ?? cutoff, cutoff), deferInboxDms: options.deferInboxDms ?? current.inFlight.deferInboxDms } : null }))
        eligible = true
        const outcome = await this.waitForAttempt(active.mutation, active.completion)
        if (!outcome.committed || !outcome.reconciled && !outcome.deferred) return { eligible, consumed: false, deferred }
        deferred ||= outcome.deferred === true
        continue
      }
      const target = scope.accepted ?? scope.dirty
      if (!target || target.generation > cutoff) break
      eligible = true
      if (scope.timer !== null) {
        clearTimeout(scope.timer)
        this.update(key, (current) => ({ ...current, timer: null }))
      }
      const outcome = await this.startSend(key, cutoff, options)
      if (!outcome.committed || !outcome.reconciled && !outcome.deferred) return { eligible, consumed: false, deferred }
      deferred ||= outcome.deferred === true
    }
    return { eligible, consumed: eligible && !deferred, deferred }
  }

  private startSend(key: string, drainCutoff?: number, options: PendingReadFlushOptions = {}): Promise<ReadAttemptOutcome> {
    const scope = this.scope(key), target = scope?.accepted ?? scope?.dirty
    if (this.disposed || !scope) return Promise.resolve({ committed: false, reconciled: false })
    if (scope.inFlight) return scope.inFlight.completion
    if (!target || scope.confirmedSeq >= target.intent.seq) {
      this.cancelConfirmedWork(key)
      return Promise.resolve({ committed: false, reconciled: false })
    }
    this.beginAttentionOptimisticRead(key)
    const controller = new AbortController(), attemptEpoch = scope.attemptEpoch + 1, identityEpoch = this.state.get().identityEpoch
    let resolve!: (outcome: ReadAttemptOutcome) => void
    const completion = new Promise<ReadAttemptOutcome>((done) => { resolve = done })
    const assertActive = () => {
      target.request.assertActive()
      if (controller.signal.aborted || !this.attemptActive(key, attemptEpoch, identityEpoch)) throw new DOMException("Retired read intent", "AbortError")
    }
    const mutation = this.queryClient.getMutationCache().build<ReadMutationResponse, Error, void, unknown>(this.queryClient, {
      mutationKey: ["community", "read-command", this.ownerUserId, target.intent.channelId],
      scope: { id: JSON.stringify(["community", "read-command", this.ownerUserId, target.intent.channelId]) },
      gcTime: 0,
      retry: (count, error) => !controller.signal.aborted && this.attemptActive(key, attemptEpoch, identityEpoch) && retryable(error) && count < 3,
      retryDelay: (count) => 250 * 2 ** count,
      mutationFn: async () => {
        assertActive()
        try {
          const response = await apiFetch<ReadMutationResponse>("/api/community/channels/" + target.intent.channelId + "/read", { ...target.request, signal: controller.signal, assertActive, method: "PUT", body: JSON.stringify({ lastReadMessageId: target.intent.messageId }) })
          assertActive()
          return response
        } catch (error) {
          assertActive()
          getAccountUnreadProjection(this.queryClient, this.ownerUserId).settleOptimisticRead(target.generation, false)
          const current = this.scope(key)!
          if (![current.accepted, current.dirty].some((pending) => pending && pending.generation > target.generation)) this.rollbackAttentionOptimisticRead(key)
          await settleInboxReadReservationGeneration(this.queryClient, target.generation, false, target.intent.channelId)
          assertActive()
          throw error
        }
      },
    })
    this.update(key, (current) => ({ ...current, accepted: null, attemptEpoch, inFlight: { target, controller, attemptEpoch, phase: "mutation", completion, mutation, drainCutoff, deferInboxDms: options.deferInboxDms } }))
    void this.performSend(key, target, attemptEpoch, identityEpoch, () => mutation.execute(undefined)).then(resolve, () => {
      if (this.attemptActive(key, attemptEpoch, identityEpoch)) {
        this.rollbackAttentionOptimisticRead(key)
        this.finishAttempt(key, attemptEpoch)
      }
      resolve({ committed: false, reconciled: false })
    })
    return drainCutoff === undefined ? completion : this.waitForAttempt(mutation, completion)
  }

  private waitForAttempt(mutation: Mutation<ReadMutationResponse, Error, void, unknown>, completion: Promise<ReadAttemptOutcome>): Promise<ReadAttemptOutcome> {
    if (mutation.state.status === "pending" && mutation.state.failureCount > 0) return Promise.resolve({ committed: false, reconciled: false })
    return new Promise((resolve) => {
      const unsubscribe = this.queryClient.getMutationCache().subscribe((event) => {
        if (event.type !== "updated" || event.mutation !== mutation || event.action.type !== "failed") return
        unsubscribe()
        resolve({ committed: false, reconciled: false })
      })
      void completion.then((outcome) => { unsubscribe(); resolve(outcome) })
    })
  }

  private async performSend(key: string, target: QueuedReadIntent, attemptEpoch: number, identityEpoch: number, request: () => Promise<ReadMutationResponse>): Promise<ReadAttemptOutcome> {
    let response: ReadMutationResponse
    try { response = await request() }
    catch (error) {
      if (!this.attemptActive(key, attemptEpoch, identityEpoch)) return { committed: false, reconciled: false }
      await settleInboxReadReservationGeneration(this.queryClient, target.generation, false, target.intent.channelId)
      if (!this.attemptActive(key, attemptEpoch, identityEpoch)) return { committed: false, reconciled: false }
      getAccountUnreadProjection(this.queryClient, this.ownerUserId).settleOptimisticRead(target.generation, false)
      const current = this.scope(key)!
      if (![current.accepted, current.dirty].some((pending) => pending && pending.generation > target.generation)) this.rollbackAttentionOptimisticRead(key)
      if (!retryable(error)) this.update(key, (scope) => ({ ...scope, dirty: scope.dirty && sameIntent(scope.dirty, target) ? null : scope.dirty }))
      this.finishAttempt(key, attemptEpoch)
      return { committed: false, reconciled: false }
    }
    if (!this.attemptActive(key, attemptEpoch, identityEpoch)) return { committed: false, reconciled: false }
    await settleInboxReadReservationGeneration(this.queryClient, target.generation, true, target.intent.channelId)
    if (!this.attemptActive(key, attemptEpoch, identityEpoch)) return { committed: false, reconciled: false }
    this.update(key, (scope) => ({ ...scope, confirmedSeq: Math.max(scope.confirmedSeq, response.targetSeq), dirty: sameIntent(scope.dirty ?? target, target) ? null : scope.dirty, inFlight: scope.inFlight ? { ...scope.inFlight, phase: "reconciling" } : null }))
    getAccountUnreadProjection(this.queryClient, this.ownerUserId).settleOptimisticRead(target.generation, true, response.targetSeq)
    const current = this.scope(key)!, active = current.inFlight!
    const defer = active.deferInboxDms?.() === true || active.drainCutoff !== undefined && current.accepted !== null && current.accepted.generation > active.drainCutoff
    try {
      target.request.assertActive()
      const registry = getCommunityDbRegistry(this.queryClient)
      await Promise.all([
        reconcileAccountReadState(this.queryClient, { surfaceMode: defer ? "non-inbox" : "all", awaitSurfaceMode: defer ? "none" : "inbox-dms", targetRevision: response.revision }),
        registry ? reconcileAccountAttention(registry).catch(() => undefined) : Promise.resolve(),
      ])
      if (!this.attemptActive(key, attemptEpoch, identityEpoch)) return { committed: true, reconciled: false }
      target.request.assertActive()
      publishInboxProjectionGenerationTerminal(this.queryClient, target.generation, defer ? "deferred" : "success")
      return defer ? { committed: true, reconciled: false, deferred: true } : { committed: true, reconciled: true }
    } catch {
      if (this.attemptActive(key, attemptEpoch, identityEpoch)) publishInboxProjectionGenerationTerminal(this.queryClient, target.generation, "error")
      return { committed: true, reconciled: false }
    } finally {
      if (this.attemptActive(key, attemptEpoch, identityEpoch)) {
        const latest = this.scope(key)!
        if (!latest.accepted && !latest.dirty) await this.commitAttentionOptimisticRead(key)
        this.finishAttempt(key, attemptEpoch)
      }
    }
  }

  private finishAttempt(key: string, attemptEpoch: number) {
    const scope = this.scope(key)
    if (!scope || scope.inFlight?.attemptEpoch !== attemptEpoch) return
    const cutoff = scope.inFlight.drainCutoff
    this.update(key, (current) => ({ ...current, inFlight: null }))
    if (this.disposed || !scope.accepted) return
    this.schedule(key, cutoff !== undefined && scope.accepted.generation <= cutoff ? 0 : Math.max(0, scope.accepted.dueAt - Date.now()))
  }

  private cancelConfirmedWork(key: string) {
    const scope = this.scope(key)
    if (!scope) return
    const accepted = scope.accepted && scope.confirmedSeq >= scope.accepted.intent.seq ? null : scope.accepted
    const dirty = scope.dirty && scope.confirmedSeq >= scope.dirty.intent.seq ? null : scope.dirty
    const canceled = scope.inFlight?.phase === "mutation" && scope.confirmedSeq >= scope.inFlight.target.intent.seq
    if (!accepted && scope.timer !== null) clearTimeout(scope.timer)
    this.update(key, (current) => ({ ...current, accepted, dirty, timer: accepted ? current.timer : null, ...(canceled ? { attemptEpoch: current.attemptEpoch + 1, inFlight: null } : {}) }))
    if (canceled) scope.inFlight!.controller.abort()
    const latest = this.scope(key)!
    if (accepted && !latest.inFlight) this.schedule(key, Math.max(0, accepted.dueAt - Date.now()))
    if (!accepted && !dirty && !latest.inFlight) {
      this.commitAttentionOptimisticRead(key)
      const registry = getCommunityDbRegistry(this.queryClient)
      if (registry) void reconcileAccountAttention(registry).catch(() => undefined)
    }
  }

  private beginAttentionOptimisticRead(key: string) {
    const scope = this.scope(key)
    if (!scope) return
    const targetSeq = scope.accepted?.intent.seq ?? scope.dirty?.intent.seq ?? 0
    if (scope.attentionOptimistic && scope.attentionOptimistic.snapshot.targetSeq >= targetSeq) return
    if (scope.attentionOptimistic) this.rollbackAttentionOptimisticRead(key)
    const registry = getCommunityDbRegistry(this.queryClient)
    if (!registry || hasAttentionScopeOptimisticFence(this.queryClient, scope.surface.channelId, targetSeq)) return
    const snapshot = clearAttentionScopeOptimistically(registry, scope.surface.channelId, targetSeq)
    this.update(key, (current) => ({ ...current, attentionOptimistic: { registry, snapshot } }))
  }

  private async commitAttentionOptimisticRead(key: string) {
    const optimistic = this.scope(key)?.attentionOptimistic
    if (!optimistic) return
    this.update(key, (current) => ({ ...current, attentionOptimistic: null }))
    await commitAttentionScopeOptimisticSnapshot(optimistic.registry, optimistic.snapshot)
  }

  private rollbackAttentionOptimisticRead(key: string) {
    const optimistic = this.scope(key)?.attentionOptimistic
    if (!optimistic) return
    this.update(key, (current) => ({ ...current, attentionOptimistic: null }))
    if (!restoreAttentionScopeOptimisticSnapshot(optimistic.registry, optimistic.snapshot)) {
      const registry = getCommunityDbRegistry(this.queryClient)
      if (registry === optimistic.registry) void reconcileAccountAttention(registry).catch(() => undefined)
    }
  }

  private validState(lease: SurfaceLease) {
    const scope = this.scope(lease.key)
    return !this.disposed && lease.coordinator === this && scope?.epoch === lease.epoch && scope.leases.has(lease.token) ? scope : null
  }
  private attemptActive(key: string, attemptEpoch: number, identityEpoch: number) {
    const scope = this.scope(key)
    return !this.disposed && this.state.get().identityEpoch === identityEpoch && scope?.inFlight?.attemptEpoch === attemptEpoch && scope.attemptEpoch === attemptEpoch
  }
  private assertActive() { if (this.disposed) throw new Error("read coordinator disposed") }
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
