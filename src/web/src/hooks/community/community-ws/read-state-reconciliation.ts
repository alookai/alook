import { notifyManager, type QueryClient, type QueryKey } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api/client"
import { communityKeys } from "@/lib/query-keys"
import { projectReadCoordinatorSnapshot } from "@/hooks/community/read-coordinator-snapshot-projection"

type AccountReadState = {
  channelId: string
  lastReadMessageId: string | null
  lastReadAt: string
  lastReadSeq: number
}

export type AccountReadStateSnapshot = {
  revision: number
  readStates: AccountReadState[]
  forumOpenerReads?: Array<{
    openerMessageId: string
    readAt: string
  }>
}

export type ReadStateEnvelope = {
  revision: number
  inboxChanged: true
}

type ReconciliationState = {
  highestPendingTargetRevision: number | null
  snapshotRequestedGeneration: number
  snapshotCompletedGeneration: number
  surfaceRequestedGeneration: number
  surfaceCompletedGeneration: number
  worker: Promise<AccountReadStateSnapshot> | null
  retryTimer: ReturnType<typeof setTimeout> | null
  retryDelayMs: number
  requestController: AbortController | null
  epoch: number
  disposed: boolean
}

const INITIAL_RETRY_DELAY_MS = 100
const MAX_RETRY_DELAY_MS = 5_000
const reconciliationStates = new WeakMap<QueryClient, ReconciliationState>()
const disposedReconciliationClients = new WeakSet<QueryClient>()

const emptyReadState = {
  lastReadMessageId: null,
  lastReadAt: null,
  lastReadSeq: 0,
}

function cachedReadStateTarget(key: QueryKey) {
  if (
    key[0] === "community"
    && (key[1] === "channel" || key[1] === "dm")
    && typeof key[2] === "string"
    && key[3] === "read-state-snapshot"
  ) {
    return { kind: key[1], channelId: key[2] }
  }
  return null
}

function projectReadStateRows(queryClient: QueryClient, snapshot: AccountReadStateSnapshot) {
  const byChannel = new Map(snapshot.readStates.map((row) => [row.channelId, row]))
  for (const query of queryClient.getQueryCache().getAll()) {
    const target = cachedReadStateTarget(query.queryKey)
    if (!target) continue
    const row = byChannel.get(target.channelId)
    queryClient.setQueryData(query.queryKey, row
      ? {
          lastReadMessageId: row.lastReadMessageId,
          lastReadAt: row.lastReadAt,
          lastReadSeq: row.lastReadSeq,
        }
      : emptyReadState)
  }
}

function applyAccountReadStateSnapshot(
  queryClient: QueryClient,
  snapshot: AccountReadStateSnapshot,
) {
  const current = queryClient.getQueryData<AccountReadStateSnapshot>(
    communityKeys.accountReadStateSnapshot(),
  )
  if (current && snapshot.revision < current.revision) return "stale" as const
  if (current?.revision === snapshot.revision) {
    // Same revision is the same authoritative account snapshot by contract.
    // Re-project leaf caches in case one mounted after the first application,
    // but do not trigger a second round of derived-surface refetches when
    // concurrent auth/live reconciliations joined the same HTTP request.
    projectReadStateRows(queryClient, snapshot)
    projectReadCoordinatorSnapshot(queryClient, snapshot)
    return "stale" as const
  }
  notifyManager.batch(() => {
    queryClient.setQueryData(communityKeys.accountReadStateSnapshot(), snapshot)
    projectReadStateRows(queryClient, snapshot)
    projectReadCoordinatorSnapshot(queryClient, snapshot)
  })
  return "applied" as const
}

async function invalidateReadStateSurfaces(queryClient: QueryClient) {
  const serverIds = new Set<string>()
  for (const query of queryClient.getQueryCache().getAll()) {
    const key = query.queryKey
    if (
      key[0] === "community"
      && key[1] === "servers"
      && typeof key[2] === "string"
      && key[2] !== "__none__"
      && key.length === 3
    ) serverIds.add(key[2])
  }
  const refetchOptions = { throwOnError: true, cancelRefetch: true }
  const settled = await Promise.allSettled([
    queryClient.invalidateQueries(
      { queryKey: communityKeys.inbox(), refetchType: "active" },
      refetchOptions,
    ),
    queryClient.invalidateQueries(
      { queryKey: communityKeys.dms(), refetchType: "active" },
      refetchOptions,
    ),
    queryClient.invalidateQueries(
      { queryKey: communityKeys.servers(), exact: true, refetchType: "active" },
      refetchOptions,
    ),
    ...[...serverIds].map((serverId) => queryClient.invalidateQueries({
      queryKey: communityKeys.server(serverId),
      exact: true,
      refetchType: "active",
    }, refetchOptions)),
  ])
  if (settled.some((result) => result.status === "rejected")) {
    throw new Error("read-state surface reconciliation failed")
  }
}

export async function reconcileAccountReadState(
  queryClient: QueryClient,
  options: { invalidateSurfaces?: boolean; targetRevision?: number } = {},
) {
  if (disposedReconciliationClients.has(queryClient)) {
    throw new Error("account read-state reconciliation disposed")
  }
  const state = getReconciliationState(queryClient)
  const currentRevision = cachedAccountRevision(queryClient)
  const targetRevision = options.targetRevision
  const hadSnapshotWork = hasSnapshotWork(state, currentRevision)

  if (targetRevision === undefined) {
    // Coalesce concurrent lifecycle callers into the already-pending primary
    // read, but make a later lifecycle event take ownership of a failed worker
    // whose target/dirty state is still queued.
    if (!hadSnapshotWork) state.snapshotRequestedGeneration += 1
  } else if (
    targetRevision > currentRevision
    && (state.highestPendingTargetRevision === null
      || targetRevision > state.highestPendingTargetRevision)
  ) {
    state.highestPendingTargetRevision = targetRevision
    state.snapshotRequestedGeneration += 1
  }

  if (
    options.invalidateSurfaces !== false
    && state.snapshotRequestedGeneration > state.surfaceRequestedGeneration
  ) {
    // Bind derived work to the authoritative snapshot generation that caused
    // it. Callers joining the same primary read coalesce, while a newer hint
    // arriving during invalidation advances both generations and therefore
    // receives a second surface pass after its newer snapshot lands.
    state.surfaceRequestedGeneration = state.snapshotRequestedGeneration
  }

  if (state.retryTimer !== null) {
    clearTimeout(state.retryTimer)
    state.retryTimer = null
  }
  return ensureReconciliationWorker(queryClient, state)
}

function getReconciliationState(queryClient: QueryClient) {
  const current = reconciliationStates.get(queryClient)
  if (current) return current
  const created: ReconciliationState = {
    highestPendingTargetRevision: null,
    snapshotRequestedGeneration: 0,
    snapshotCompletedGeneration: 0,
    surfaceRequestedGeneration: 0,
    surfaceCompletedGeneration: 0,
    worker: null,
    retryTimer: null,
    retryDelayMs: INITIAL_RETRY_DELAY_MS,
    requestController: null,
    epoch: 0,
    disposed: false,
  }
  reconciliationStates.set(queryClient, created)
  return created
}

function cachedAccountRevision(queryClient: QueryClient) {
  return queryClient.getQueryData<AccountReadStateSnapshot>(
    communityKeys.accountReadStateSnapshot(),
  )?.revision ?? -1
}

function hasSnapshotWork(state: ReconciliationState, currentRevision: number) {
  return (
    state.snapshotCompletedGeneration < state.snapshotRequestedGeneration
    || (state.highestPendingTargetRevision !== null
      && currentRevision < state.highestPendingTargetRevision)
  )
}

function hasSurfaceWork(state: ReconciliationState) {
  return state.surfaceCompletedGeneration < state.surfaceRequestedGeneration
}

function hasReconciliationWork(queryClient: QueryClient, state: ReconciliationState) {
  return hasSnapshotWork(state, cachedAccountRevision(queryClient)) || hasSurfaceWork(state)
}

function scheduleReconciliationRetry(queryClient: QueryClient, state: ReconciliationState) {
  if (
    state.disposed
    || state.retryTimer !== null
    || !hasReconciliationWork(queryClient, state)
  ) return
  const delay = state.retryDelayMs
  state.retryDelayMs = Math.min(delay * 2, MAX_RETRY_DELAY_MS)
  state.retryTimer = setTimeout(() => {
    state.retryTimer = null
    void ensureReconciliationWorker(queryClient, state).catch(() => undefined)
  }, delay)
}

function ensureReconciliationWorker(queryClient: QueryClient, state: ReconciliationState) {
  if (state.disposed) return Promise.reject(new Error("account read-state reconciliation disposed"))
  if (state.worker) return state.worker
  const worker = runReconciliationWorker(queryClient, state).finally(() => {
    if (state.worker === worker) state.worker = null
    if (hasReconciliationWork(queryClient, state)) {
      scheduleReconciliationRetry(queryClient, state)
    }
  })
  state.worker = worker
  return worker
}

async function runReconciliationWorker(
  queryClient: QueryClient,
  state: ReconciliationState,
): Promise<AccountReadStateSnapshot> {
  const epoch = state.epoch
  while (true) {
    assertReconciliationActive(queryClient, state, epoch)
    const currentRevision = cachedAccountRevision(queryClient)
    if (hasSnapshotWork(state, currentRevision)) {
      const requestGeneration = state.snapshotRequestedGeneration
      let snapshot: AccountReadStateSnapshot
      try {
        snapshot = await startAccountReadStateRequest(state)
      } catch (error) {
        scheduleReconciliationRetry(queryClient, state)
        throw error
      }
      assertReconciliationActive(queryClient, state, epoch)
      applyAccountReadStateSnapshot(queryClient, snapshot)
      state.snapshotCompletedGeneration = Math.max(
        state.snapshotCompletedGeneration,
        requestGeneration,
      )
      const appliedRevision = cachedAccountRevision(queryClient)
      if (
        state.highestPendingTargetRevision !== null
        && appliedRevision >= state.highestPendingTargetRevision
      ) {
        state.highestPendingTargetRevision = null
      }
      // If this primary read was older than a live target, or another caller
      // arrived while it was in flight, loop immediately and issue a genuinely
      // fresh request. No timer/backoff is needed for a successful stale read.
      continue
    }

    if (hasSurfaceWork(state)) {
      const surfaceGeneration = state.surfaceRequestedGeneration
      try {
        await invalidateReadStateSurfaces(queryClient)
      } catch (error) {
        scheduleReconciliationRetry(queryClient, state)
        throw error
      }
      assertReconciliationActive(queryClient, state, epoch)
      state.surfaceCompletedGeneration = Math.max(
        state.surfaceCompletedGeneration,
        surfaceGeneration,
      )
      continue
    }

    const snapshot = queryClient.getQueryData<AccountReadStateSnapshot>(
      communityKeys.accountReadStateSnapshot(),
    )
    if (!snapshot) throw new Error("account read-state reconciliation produced no snapshot")
    state.retryDelayMs = INITIAL_RETRY_DELAY_MS
    return snapshot
  }
}

function assertReconciliationActive(
  queryClient: QueryClient,
  state: ReconciliationState,
  epoch: number,
) {
  if (
    state.disposed
    || state.epoch !== epoch
    || reconciliationStates.get(queryClient) !== state
  ) throw new Error("account read-state reconciliation disposed")
}

function startAccountReadStateRequest(state: ReconciliationState) {
  const controller = new AbortController()
  state.requestController = controller
  return apiFetch<AccountReadStateSnapshot>(
    "/api/community/users/me/read-state",
    { signal: controller.signal },
  ).finally(() => {
    if (state.requestController === controller) state.requestController = null
  })
}

export function disposeAccountReadStateReconciliation(queryClient: QueryClient) {
  disposedReconciliationClients.add(queryClient)
  const state = reconciliationStates.get(queryClient)
  if (!state || state.disposed) return
  state.disposed = true
  state.epoch += 1
  state.highestPendingTargetRevision = null
  state.snapshotCompletedGeneration = state.snapshotRequestedGeneration
  state.surfaceCompletedGeneration = state.surfaceRequestedGeneration
  if (state.retryTimer !== null) {
    clearTimeout(state.retryTimer)
    state.retryTimer = null
  }
  state.requestController?.abort()
  state.requestController = null
}

export function projectReadStateEnvelope(
  queryClient: QueryClient,
  envelope: ReadStateEnvelope,
) {
  const snapshot = queryClient.getQueryData<AccountReadStateSnapshot>(
    communityKeys.accountReadStateSnapshot(),
  )
  if (!snapshot) return "gap" as const
  const state = reconciliationStates.get(queryClient)
  if (state && hasSurfaceWork(state) && envelope.revision <= snapshot.revision) {
    return "gap" as const
  }
  if (envelope.revision <= snapshot.revision) return "stale" as const
  return "gap" as const
}
