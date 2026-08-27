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
}

export type ReadStateEnvelope = {
  revision: number
  inboxChanged: true
}

type ReconciliationState = {
  highestPendingTargetRevision: number | null
  snapshotRequestedGeneration: number
  snapshotCompletedGeneration: number
  inboxDmsRequestedGeneration: number
  inboxDmsCompletedGeneration: number
  serverRequestedGeneration: number
  serverCompletedGeneration: number
  snapshotWorker: Promise<AccountReadStateSnapshot> | null
  inboxDmsWorker: Promise<void> | null
  serverWorker: Promise<void> | null
  snapshotRetryTimer: ReturnType<typeof setTimeout> | null
  snapshotRetryDelayMs: number
  inboxDmsRetryTimer: ReturnType<typeof setTimeout> | null
  inboxDmsRetryDelayMs: number
  serverRetryTimer: ReturnType<typeof setTimeout> | null
  serverRetryDelayMs: number
  requestController: AbortController | null
  epoch: number
  disposed: boolean
}

export type ReadStateSurfaceMode = "all" | "inbox-dms" | "non-inbox" | "none"

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

async function invalidateInboxDmsSurfaces(queryClient: QueryClient) {
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
  ])
  if (settled.some((result) => result.status === "rejected")) {
    throw new Error("read-state Inbox/DM reconciliation failed")
  }
}

async function invalidateServerSurfaces(queryClient: QueryClient) {
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
    throw new Error("read-state server reconciliation failed")
  }
}

export async function reconcileAccountReadState(
  queryClient: QueryClient,
  options: {
    invalidateSurfaces?: boolean
    surfaceMode?: ReadStateSurfaceMode
    awaitSurfaceMode?: ReadStateSurfaceMode
    targetRevision?: number
  } = {},
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

  const surfaceMode = options.invalidateSurfaces === false
    ? "none"
    : (options.surfaceMode ?? "all")
  const awaitSurfaceMode = options.awaitSurfaceMode ?? surfaceMode
  const requestedGeneration = state.snapshotRequestedGeneration
  if (surfaceMode === "all" || surfaceMode === "inbox-dms") {
    state.inboxDmsRequestedGeneration = Math.max(
      state.inboxDmsRequestedGeneration,
      requestedGeneration,
    )
  }
  if (surfaceMode === "all" || surfaceMode === "non-inbox") {
    state.serverRequestedGeneration = Math.max(
      state.serverRequestedGeneration,
      requestedGeneration,
    )
  }

  clearReconciliationRetry(state, "snapshot")
  if (awaitSurfaceMode === "all" || awaitSurfaceMode === "inbox-dms") {
    clearReconciliationRetry(state, "inbox-dms")
  }
  if (awaitSurfaceMode === "all" || awaitSurfaceMode === "non-inbox") {
    clearReconciliationRetry(state, "non-inbox")
  }
  await ensureSnapshotWorker(queryClient, state)
  const inboxWorker = surfaceMode === "all" || surfaceMode === "inbox-dms"
    ? ensureInboxDmsWorker(queryClient, state)
    : null
  const serverWorker = surfaceMode === "all" || surfaceMode === "non-inbox"
    ? ensureServerWorker(queryClient, state)
    : null
  const awaited: Promise<void>[] = []
  if (awaitSurfaceMode === "all" || awaitSurfaceMode === "inbox-dms") {
    awaited.push(inboxWorker ?? ensureInboxDmsWorker(queryClient, state))
  } else {
    void inboxWorker?.catch(() => undefined)
  }
  if (awaitSurfaceMode === "all" || awaitSurfaceMode === "non-inbox") {
    awaited.push(serverWorker ?? ensureServerWorker(queryClient, state))
  } else {
    void serverWorker?.catch(() => undefined)
  }
  await Promise.all(awaited)
  const snapshot = queryClient.getQueryData<AccountReadStateSnapshot>(
    communityKeys.accountReadStateSnapshot(),
  )
  if (!snapshot) throw new Error("account read-state reconciliation produced no snapshot")
  return snapshot
}

function getReconciliationState(queryClient: QueryClient) {
  const current = reconciliationStates.get(queryClient)
  if (current) return current
  const created: ReconciliationState = {
    highestPendingTargetRevision: null,
    snapshotRequestedGeneration: 0,
    snapshotCompletedGeneration: 0,
    inboxDmsRequestedGeneration: 0,
    inboxDmsCompletedGeneration: 0,
    serverRequestedGeneration: 0,
    serverCompletedGeneration: 0,
    snapshotWorker: null,
    inboxDmsWorker: null,
    serverWorker: null,
    snapshotRetryTimer: null,
    snapshotRetryDelayMs: INITIAL_RETRY_DELAY_MS,
    inboxDmsRetryTimer: null,
    inboxDmsRetryDelayMs: INITIAL_RETRY_DELAY_MS,
    serverRetryTimer: null,
    serverRetryDelayMs: INITIAL_RETRY_DELAY_MS,
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

function hasInboxDmsWork(state: ReconciliationState) {
  return state.inboxDmsCompletedGeneration < state.inboxDmsRequestedGeneration
}

function hasServerWork(state: ReconciliationState) {
  return state.serverCompletedGeneration < state.serverRequestedGeneration
}

type RetryFamily = "snapshot" | "inbox-dms" | "non-inbox"

function hasFamilyWork(
  queryClient: QueryClient,
  state: ReconciliationState,
  family: RetryFamily,
) {
  if (family === "snapshot") {
    return hasSnapshotWork(state, cachedAccountRevision(queryClient))
  }
  return family === "inbox-dms" ? hasInboxDmsWork(state) : hasServerWork(state)
}

function clearReconciliationRetry(state: ReconciliationState, family: RetryFamily) {
  const timer = family === "snapshot"
    ? state.snapshotRetryTimer
    : family === "inbox-dms"
      ? state.inboxDmsRetryTimer
      : state.serverRetryTimer
  if (timer !== null) clearTimeout(timer)
  if (family === "snapshot") state.snapshotRetryTimer = null
  else if (family === "inbox-dms") state.inboxDmsRetryTimer = null
  else state.serverRetryTimer = null
}

function scheduleReconciliationRetry(
  queryClient: QueryClient,
  state: ReconciliationState,
  family: RetryFamily,
) {
  const timer = family === "snapshot"
    ? state.snapshotRetryTimer
    : family === "inbox-dms"
      ? state.inboxDmsRetryTimer
      : state.serverRetryTimer
  if (state.disposed || timer !== null || !hasFamilyWork(queryClient, state, family)) return
  const delay = family === "snapshot"
    ? state.snapshotRetryDelayMs
    : family === "inbox-dms"
      ? state.inboxDmsRetryDelayMs
      : state.serverRetryDelayMs
  if (family === "snapshot") {
    state.snapshotRetryDelayMs = Math.min(delay * 2, MAX_RETRY_DELAY_MS)
  } else if (family === "inbox-dms") {
    state.inboxDmsRetryDelayMs = Math.min(delay * 2, MAX_RETRY_DELAY_MS)
  } else {
    state.serverRetryDelayMs = Math.min(delay * 2, MAX_RETRY_DELAY_MS)
  }
  const callback = () => {
    if (family === "snapshot") state.snapshotRetryTimer = null
    else if (family === "inbox-dms") state.inboxDmsRetryTimer = null
    else state.serverRetryTimer = null
    if (family === "snapshot") {
      void ensureSnapshotWorker(queryClient, state)
        .then(() => kickPendingSurfaceWorkers(queryClient, state))
        .catch(() => undefined)
    } else if (family === "inbox-dms") {
      void ensureInboxDmsWorker(queryClient, state).catch(() => undefined)
    } else {
      void ensureServerWorker(queryClient, state).catch(() => undefined)
    }
  }
  const nextTimer = setTimeout(callback, delay)
  if (family === "snapshot") state.snapshotRetryTimer = nextTimer
  else if (family === "inbox-dms") state.inboxDmsRetryTimer = nextTimer
  else state.serverRetryTimer = nextTimer
}

function ensureSnapshotWorker(queryClient: QueryClient, state: ReconciliationState) {
  if (state.disposed) return Promise.reject(new Error("account read-state reconciliation disposed"))
  if (state.snapshotWorker) return state.snapshotWorker
  const worker = runSnapshotWorker(queryClient, state).finally(() => {
    if (state.snapshotWorker === worker) state.snapshotWorker = null
  })
  state.snapshotWorker = worker
  return worker
}

async function runSnapshotWorker(
  queryClient: QueryClient,
  state: ReconciliationState,
): Promise<AccountReadStateSnapshot> {
  const epoch = state.epoch
  while (hasSnapshotWork(state, cachedAccountRevision(queryClient))) {
    assertReconciliationActive(queryClient, state, epoch)
    const requestGeneration = state.snapshotRequestedGeneration
    let snapshot: AccountReadStateSnapshot
    try {
      snapshot = await startAccountReadStateRequest(state)
    } catch (error) {
      scheduleReconciliationRetry(queryClient, state, "snapshot")
      throw error
    }
    assertReconciliationActive(queryClient, state, epoch)
    applyAccountReadStateSnapshot(queryClient, snapshot)
    state.snapshotCompletedGeneration = Math.max(
      state.snapshotCompletedGeneration,
      requestGeneration,
    )
    state.snapshotRetryDelayMs = INITIAL_RETRY_DELAY_MS
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
  }
  const snapshot = queryClient.getQueryData<AccountReadStateSnapshot>(
    communityKeys.accountReadStateSnapshot(),
  )
  if (!snapshot) throw new Error("account read-state reconciliation produced no snapshot")
  return snapshot
}

function ensureInboxDmsWorker(queryClient: QueryClient, state: ReconciliationState) {
  if (state.disposed) return Promise.reject(new Error("account read-state reconciliation disposed"))
  if (!hasInboxDmsWork(state)) return Promise.resolve()
  if (state.inboxDmsWorker) return state.inboxDmsWorker
  const worker = runInboxDmsWorker(queryClient, state).finally(() => {
    if (state.inboxDmsWorker === worker) state.inboxDmsWorker = null
  })
  state.inboxDmsWorker = worker
  return worker
}

async function runInboxDmsWorker(queryClient: QueryClient, state: ReconciliationState) {
  const epoch = state.epoch
  while (hasInboxDmsWork(state)) {
    await ensureSnapshotWorker(queryClient, state)
    assertReconciliationActive(queryClient, state, epoch)
    const surfaceGeneration = state.inboxDmsRequestedGeneration
    try {
      await invalidateInboxDmsSurfaces(queryClient)
    } catch {
      scheduleReconciliationRetry(queryClient, state, "inbox-dms")
      throw new Error("read-state surface reconciliation failed")
    }
    assertReconciliationActive(queryClient, state, epoch)
    state.inboxDmsCompletedGeneration = Math.max(
      state.inboxDmsCompletedGeneration,
      surfaceGeneration,
    )
    state.inboxDmsRetryDelayMs = INITIAL_RETRY_DELAY_MS
  }
}

function ensureServerWorker(queryClient: QueryClient, state: ReconciliationState) {
  if (state.disposed) return Promise.reject(new Error("account read-state reconciliation disposed"))
  if (!hasServerWork(state)) return Promise.resolve()
  if (state.serverWorker) return state.serverWorker
  const worker = runServerWorker(queryClient, state).finally(() => {
    if (state.serverWorker === worker) state.serverWorker = null
  })
  state.serverWorker = worker
  return worker
}

async function runServerWorker(queryClient: QueryClient, state: ReconciliationState) {
  const epoch = state.epoch
  while (hasServerWork(state)) {
    await ensureSnapshotWorker(queryClient, state)
    assertReconciliationActive(queryClient, state, epoch)
    const surfaceGeneration = state.serverRequestedGeneration
    try {
      await invalidateServerSurfaces(queryClient)
    } catch {
      scheduleReconciliationRetry(queryClient, state, "non-inbox")
      throw new Error("read-state surface reconciliation failed")
    }
    assertReconciliationActive(queryClient, state, epoch)
    state.serverCompletedGeneration = Math.max(
      state.serverCompletedGeneration,
      surfaceGeneration,
    )
    state.serverRetryDelayMs = INITIAL_RETRY_DELAY_MS
  }
}

function kickPendingSurfaceWorkers(queryClient: QueryClient, state: ReconciliationState) {
  if (state.inboxDmsRetryTimer === null && hasInboxDmsWork(state)) {
    void ensureInboxDmsWorker(queryClient, state).catch(() => undefined)
  }
  if (state.serverRetryTimer === null && hasServerWork(state)) {
    void ensureServerWorker(queryClient, state).catch(() => undefined)
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
  state.inboxDmsCompletedGeneration = state.inboxDmsRequestedGeneration
  state.serverCompletedGeneration = state.serverRequestedGeneration
  clearReconciliationRetry(state, "snapshot")
  clearReconciliationRetry(state, "inbox-dms")
  clearReconciliationRetry(state, "non-inbox")
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
  if (state && hasInboxDmsWork(state) && envelope.revision <= snapshot.revision) {
    return "gap" as const
  }
  if (envelope.revision <= snapshot.revision) return "stale" as const
  return "gap" as const
}
