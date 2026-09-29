import {
  DbClient,
  collectionOptions,
  localOnlyCollectionOptions,
  type Collection,
  type PendingMutation,
} from "@tanstack/react-db"
import { persistedCollectionOptions } from "@tanstack/browser-db-sqlite-persistence"
import type { PersistedCollectionPersistence } from "@tanstack/browser-db-sqlite-persistence"
import {
  queryCollectionOptions,
  type QueryCollectionUtils,
} from "@tanstack/query-db-collection"
import { QueryClient } from "@tanstack/react-query"
import type { z } from "zod"
import { getBrowserPersistenceRuntime } from "@/lib/browser-persistence"
import {
  categorySchema,
  attentionItemSchema,
  attentionScopeSchema,
  channelMembershipSchema,
  channelSchema,
  folderItemSchema,
  folderSchema,
  messageSchema,
  notificationSettingSchema,
  profileSchema,
  readStateClockSchema,
  readStateSchema,
  serverMembershipSchema,
  serverSchema,
  type MessageRow,
  type ServerRow,
} from "./schema"
import {
  createServersQueryFn,
  selectServersForCollection,
  serversCollectionQueryKey,
} from "./server-collection"

const INACTIVE_MESSAGE_SCOPE_LIMIT = 20
const INACTIVE_MESSAGE_LIMIT = 50
const COMMUNITY_DB_TRACE_LIMIT = 512

type ServerRowSummary = {
  complete: number
  incomplete: number
  rows: number
}

type ServerRowState = {
  detailComplete: boolean
  row: string
}

type ServerRowsSnapshot = {
  rows: ServerRowState[]
  summary: ServerRowSummary
}

type ServerMutationSummary = {
  deletes: number
  detailFalse: number
  detailTrue: number
  inserts: number
  updates: number
}

type ServerLifecycleTransaction = {
  forwarded: boolean
  id: string
  origin: "manual" | "query" | "unknown"
  queryId: string | null
  summary: ServerMutationSummary
}

type CommunityDbLifecycleEvent = {
  at: number
  detail: Record<string, boolean | number | string | null | ServerMutationSummary | ServerRowSummary>
  kind: string
  registryId: string
  runId: string
  seq: number
  snapshot: {
    readiness: string
    synced: ServerRowsSnapshot
    visible: ServerRowsSnapshot
  }
}

type CommunityDbLifecycleTimeline = {
  dropped: number
  events: CommunityDbLifecycleEvent[]
  registryId: string
  runId: string
}

type CommunityDbTraceGlobal = typeof globalThis & {
  __ALOOK_COMMUNITY_DB_TRACE_REGISTRY_SEQUENCE__?: number
  __ALOOK_COMMUNITY_DB_TRACE_RUN_ID__?: string
  __ALOOK_COMMUNITY_DB_TRACE_SEQUENCE__?: number
  __ALOOK_COMMUNITY_DB_TRACE_STORE__?: {
    dropped: number
    events: CommunityDbLifecycleEvent[]
    runId: string
  }
}

type CommunityDbLifecycleRecorder = {
  record: (
    kind: string,
    detail?: CommunityDbLifecycleEvent["detail"],
  ) => void
  timeline: () => CommunityDbLifecycleTimeline
}

type CommunityDbLifecycleRecord = CommunityDbLifecycleRecorder["record"]

function recordCommunityDbLifecycle(
  record: CommunityDbLifecycleRecord,
  kind: string,
  detail?: CommunityDbLifecycleEvent["detail"],
): void {
  try {
    record(kind, detail)
  } catch {
    return
  }
}

function emptyServerRowSummary(): ServerRowSummary {
  return { complete: 0, incomplete: 0, rows: 0 }
}

function summarizeServerRows(rows: Iterable<ServerRow>): ServerRowSummary {
  const summary = emptyServerRowSummary()
  for (const row of rows) {
    summary.rows += 1
    if (row.detailComplete) summary.complete += 1
    else summary.incomplete += 1
  }
  return summary
}

function snapshotServerRows(
  rows: Iterable<ServerRow>,
  rowTokens: Map<string, string>,
): ServerRowsSnapshot {
  const states: ServerRowState[] = []
  const summary = emptyServerRowSummary()
  for (const row of rows) {
    let token = rowTokens.get(row.id)
    if (!token) {
      token = `row-${rowTokens.size + 1}`
      rowTokens.set(row.id, token)
    }
    summary.rows += 1
    if (row.detailComplete) summary.complete += 1
    else summary.incomplete += 1
    states.push({ detailComplete: row.detailComplete, row: token })
  }
  states.sort((left, right) => left.row.localeCompare(right.row))
  return { rows: states, summary }
}

function emptyServerMutationSummary(): ServerMutationSummary {
  return { deletes: 0, detailFalse: 0, detailTrue: 0, inserts: 0, updates: 0 }
}

function recordServerMutation(
  summary: ServerMutationSummary,
  message: { type: string; value?: unknown },
): void {
  if (message.type === "delete") summary.deletes += 1
  else if (message.type === "insert") summary.inserts += 1
  else summary.updates += 1
  if (!message.value || typeof message.value !== "object") return
  const detailComplete = Reflect.get(message.value, "detailComplete")
  if (detailComplete === true) summary.detailTrue += 1
  if (detailComplete === false) summary.detailFalse += 1
}

function traceGlobal(): CommunityDbTraceGlobal {
  return globalThis as CommunityDbTraceGlobal
}

function createCommunityDbLifecycleRecorder(
  readReadiness: () => string,
  readSyncedRows: () => Iterable<ServerRow>,
  readVisibleRows: () => Iterable<ServerRow>,
): CommunityDbLifecycleRecorder | null {
  const global = traceGlobal()
  const runId = global.__ALOOK_COMMUNITY_DB_TRACE_RUN_ID__
  if (typeof runId !== "string" || !/^run-[a-z0-9-]{1,96}$/i.test(runId)) return null
  const registrySequence = (global.__ALOOK_COMMUNITY_DB_TRACE_REGISTRY_SEQUENCE__ ?? 0) + 1
  global.__ALOOK_COMMUNITY_DB_TRACE_REGISTRY_SEQUENCE__ = registrySequence
  const registryId = `registry-${registrySequence}`
  const store = global.__ALOOK_COMMUNITY_DB_TRACE_STORE__?.runId === runId
    ? global.__ALOOK_COMMUNITY_DB_TRACE_STORE__
    : { dropped: 0, events: [], runId }
  global.__ALOOK_COMMUNITY_DB_TRACE_STORE__ = store
  const rowTokens = new Map<string, string>()
  return {
    record: (kind, detail = {}) => {
      try {
        const seq = (global.__ALOOK_COMMUNITY_DB_TRACE_SEQUENCE__ ?? 0) + 1
        global.__ALOOK_COMMUNITY_DB_TRACE_SEQUENCE__ = seq
        if (store.events.length === COMMUNITY_DB_TRACE_LIMIT) {
          store.events.shift()
          store.dropped += 1
        }
        store.events.push({
          at: typeof performance === "undefined" ? Date.now() : performance.now(),
          detail,
          kind,
          registryId,
          runId,
          seq,
          snapshot: {
            readiness: readReadiness(),
            synced: snapshotServerRows(readSyncedRows(), rowTokens),
            visible: snapshotServerRows(readVisibleRows(), rowTokens),
          },
        })
      } catch {
        return
      }
    },
    timeline: () => {
      try {
        return {
          dropped: store.dropped,
          events: store.events.map((event) => ({
            ...event,
            detail: { ...event.detail },
            snapshot: {
              ...event.snapshot,
              synced: {
                rows: event.snapshot.synced.rows.map((row) => ({ ...row })),
                summary: { ...event.snapshot.synced.summary },
              },
              visible: {
                rows: event.snapshot.visible.rows.map((row) => ({ ...row })),
                summary: { ...event.snapshot.visible.summary },
              },
            },
          })),
          registryId,
          runId,
        }
      } catch {
        return { dropped: store.dropped, events: [], registryId, runId }
      }
    },
  }
}

export function observeCommunityDbLifecycleReceipt<T extends true | Promise<void>>(
  receipt: T,
  settled: () => void,
  rejected: () => void,
): T {
  const notify = (callback: () => void) => {
    try {
      callback()
    } catch {
      return
    }
  }
  if (receipt !== true) {
    try {
      void receipt.then(
        () => notify(settled),
        () => notify(rejected),
      ).catch(() => undefined)
    } catch {
      return receipt
    }
  } else notify(settled)
  return receipt
}

export function observeCommunityDbLifecycleLoadSubset<TOptions>(
  loadSubset: (options: TOptions) => true | Promise<void>,
  record: CommunityDbLifecycleRecord,
  nextLoadId: () => string,
): (options: TOptions) => true | Promise<void> {
  return (options) => {
    let loadId = "load-unscoped"
    try {
      loadId = nextLoadId()
    } catch {
      loadId = "load-unscoped"
    }
    recordCommunityDbLifecycle(record, "loadSubset:start", { loadId })
    const receipt = loadSubset(options)
    return observeCommunityDbLifecycleReceipt(
      receipt,
      () => recordCommunityDbLifecycle(record, "loadSubset:settle", { loadId, rejected: false }),
      () => recordCommunityDbLifecycle(record, "loadSubset:settle", { loadId, rejected: true }),
    )
  }
}

export function observeCommunityDbLifecycleCommit(
  commit: (signal?: AbortSignal) => true | Promise<void>,
  record: CommunityDbLifecycleRecord,
  boundary: "forward" | "source",
  detail: CommunityDbLifecycleEvent["detail"],
  capture: (receipt: true | Promise<void>) => void = () => {},
): (signal?: AbortSignal) => true | Promise<void> {
  return (signal) => {
    recordCommunityDbLifecycle(record, `${boundary}:commit-call`, detail)
    const receipt = commit(signal)
    try {
      capture(receipt)
    } catch {
      return receipt
    }
    recordCommunityDbLifecycle(record, `${boundary}:commit-status`, {
      ...detail,
      pending: receipt !== true,
    })
    return observeCommunityDbLifecycleReceipt(
      receipt,
      () => recordCommunityDbLifecycle(record, `${boundary}:commit-settle`, {
        ...detail,
        rejected: false,
      }),
      () => recordCommunityDbLifecycle(record, `${boundary}:commit-settle`, {
        ...detail,
        rejected: true,
      }),
    )
  }
}

type SchemaRow<TSchema extends z.ZodType> = z.output<TSchema> & object

function canonicalCollectionOptions<
  TSchema extends z.ZodType,
  TKey extends string | number,
>(
  scopeId: string,
  name: string,
  persistence: PersistedCollectionPersistence | null,
  _schema: TSchema,
  getKey: (row: SchemaRow<TSchema>) => TKey,
) {
  const id = `community-db:${scopeId}:${name}`
  const base = { id, getKey }
  return persistence
    ? persistedCollectionOptions<SchemaRow<TSchema>, TKey>({
        ...base,
        persistence,
        schemaVersion: 1,
      })
    : localOnlyCollectionOptions<SchemaRow<TSchema>, TKey>(base)
}

export function createCommunityDbRegistry(
  queryClient: QueryClient,
  accountId: string | null,
  options: {
    persistence?: PersistedCollectionPersistence | null
    serverTransport?: boolean
  } = {},
) {
  const scopeId = accountId ?? "anon"
  const dbClient = new DbClient({ queryClient })
  const persistence = options.persistence ?? null
  const serverCommitCaptures: Set<Promise<void>>[] = []
  const captureServerCollectionCommits = (publish: () => void) => {
    const receipts = new Set<Promise<void>>()
    serverCommitCaptures.push(receipts)
    try {
      publish()
    } catch (error) {
      return Promise.reject(error)
    } finally {
      serverCommitCaptures.pop()
    }
    return Promise.all(receipts).then(() => undefined)
  }

  let readServerRows = (): Iterable<ServerRow> => []
  let readServerSyncedRows = (): Iterable<ServerRow> => []
  let serverReadiness = "not-ready"
  const lifecycle = createCommunityDbLifecycleRecorder(
    () => serverReadiness,
    () => readServerSyncedRows(),
    () => readServerRows(),
  )
  let querySequence = 0
  let transactionSequence = 0
  let internalTransactionSequence = 0
  let queryApplicationSequence = 0
  let activeSourceTransaction: ServerLifecycleTransaction | null = null
  const pendingSourceTransactions: ServerLifecycleTransaction[] = []
  const queryIdsByApplication = new Map<string, string>()
  let latestResolvedQueryId: string | null = null
  let latestSelectedQueryId: string | null = null
  const serverCollectionId = `community-db:${scopeId}:servers`
  const baseServerQueryFn = createServersQueryFn(queryClient)
  const serverQueryFn = lifecycle
    ? async (context: Parameters<typeof baseServerQueryFn>[0]) => {
        const queryId = `query-${++querySequence}`
        lifecycle.record("query:start", { queryId })
        try {
          const response = await baseServerQueryFn(context)
          latestResolvedQueryId = queryId
          lifecycle.record("query:result", {
            queryId,
            result: summarizeServerRows(response.servers),
          })
          return response
        } catch (error) {
          lifecycle.record("query:error", { aborted: error instanceof DOMException && error.name === "AbortError", queryId })
          throw error
        }
      }
    : baseServerQueryFn
  const selectServerRows = (response: Awaited<ReturnType<typeof baseServerQueryFn>>) => (
    selectServersForCollection(response, readServerRows())
  )
  const tracedSelectServerRows = lifecycle
    ? (response: Awaited<ReturnType<typeof baseServerQueryFn>>) => {
        const queryState = queryClient.getQueryState(serversCollectionQueryKey())
        const dataUpdateCount = queryState?.dataUpdateCount ?? null
        const dataUpdatedAt = queryState?.dataUpdatedAt ?? null
        const applicationId = dataUpdateCount === null
          ? `application-untracked-${++queryApplicationSequence}`
          : `application-${dataUpdateCount}`
        let queryId = queryIdsByApplication.get(applicationId)
        if (!queryId) {
          queryId = latestResolvedQueryId ?? `query-untracked-${++querySequence}`
          queryIdsByApplication.set(applicationId, queryId)
        }
        latestSelectedQueryId = queryId
        lifecycle.record("select:input", {
          applicationId,
          dataUpdateCount,
          dataUpdatedAt,
          input: summarizeServerRows(response.servers),
          queryId,
        })
        const selected = selectServerRows(response)
        lifecycle.record("select:output", {
          applicationId,
          output: summarizeServerRows(selected),
          queryId,
        })
        return selected
      }
    : selectServerRows
  const serverQueryOptions = queryCollectionOptions({
    id: serverCollectionId,
    queryClient,
    queryKey: serversCollectionQueryKey(),
    queryFn: serverQueryFn,
    select: tracedSelectServerRows,
    schema: serverSchema,
    getKey: (row) => row.id,
    enabled: options.serverTransport === true,
    initialData: options.serverTransport === true
      ? undefined
      : { servers: [], unreadSources: [] },
    staleTime: Infinity,
    refetchOnReconnect: true,
  })
  const serverQuerySync = serverQueryOptions.sync
  const trackedServerQueryOptions = {
    ...serverQueryOptions,
    sync: {
      ...serverQuerySync,
      sync: (params: Parameters<typeof serverQuerySync.sync>[0]) => {
        if (!lifecycle) {
          return serverQuerySync.sync({
            ...params,
            commit: (signal?: AbortSignal) => {
              const receipt = params.commit(signal)
              if (receipt !== true) {
                const settlement = Promise.resolve(receipt)
                for (const capture of serverCommitCaptures) capture.add(settlement)
              }
              return receipt
            },
          })
        }
        const transactions: ServerLifecycleTransaction[] = []
        return serverQuerySync.sync({
          ...params,
          begin: (beginOptions) => {
            const queryId = beginOptions?.immediate ? null : latestSelectedQueryId
            const transaction: ServerLifecycleTransaction = {
              forwarded: false,
              id: `tx-${++transactionSequence}`,
              origin: beginOptions?.immediate ? "manual" : queryId ? "query" : "unknown",
              queryId,
              summary: emptyServerMutationSummary(),
            }
            transactions.push(transaction)
            lifecycle.record("source:begin", {
              immediate: beginOptions?.immediate === true,
              origin: transaction.origin,
              queryId,
              txId: transaction.id,
            })
            const priorSourceTransaction = activeSourceTransaction
            activeSourceTransaction = transaction
            try {
              params.begin(beginOptions)
            } finally {
              activeSourceTransaction = priorSourceTransaction
            }
            if (!transaction.forwarded) pendingSourceTransactions.push(transaction)
          },
          write: (message) => {
            const transaction = transactions.at(-1)
            if (transaction) recordServerMutation(transaction.summary, message)
            lifecycle.record("source:write", {
              mutations: { ...(transaction?.summary ?? emptyServerMutationSummary()) },
              origin: transaction?.origin ?? "unknown",
              queryId: transaction?.queryId ?? null,
              txId: transaction?.id ?? "source-unscoped",
            })
            params.write(message)
          },
          commit: (signal?: AbortSignal) => {
            const transaction = transactions.pop() ?? {
              forwarded: false,
              id: `tx-${++transactionSequence}`,
              origin: "unknown" as const,
              queryId: null,
              summary: emptyServerMutationSummary(),
            }
            const detail = {
              mutations: { ...transaction.summary },
              origin: transaction.origin,
              queryId: transaction.queryId,
              txId: transaction.id,
            }
            return observeCommunityDbLifecycleCommit(
              (commitSignal) => params.commit(commitSignal),
              lifecycle.record,
              "source",
              detail,
              (receipt) => {
                if (receipt === true) return
                const settlement = Promise.resolve(receipt)
                for (const capture of serverCommitCaptures) capture.add(settlement)
              },
            )(signal)
          },
        })
      },
    },
  }
  const baseServerOptions = persistence
    ? persistedCollectionOptions({
        ...trackedServerQueryOptions,
        persistence,
        schemaVersion: 1,
      })
    : trackedServerQueryOptions
  const persistedServerSync = baseServerOptions.sync
  let loadSubsetSequence = 0
  const serverOptions = lifecycle
    ? {
        ...baseServerOptions,
        sync: {
          ...persistedServerSync,
          sync: (params: Parameters<typeof persistedServerSync.sync>[0]) => {
            const transactions: ServerLifecycleTransaction[] = []
            const result = persistedServerSync.sync({
              ...params,
              begin: (beginOptions) => {
                const sourceTransaction = activeSourceTransaction
                  ?? (beginOptions?.immediate === true ? null : pendingSourceTransactions.shift() ?? null)
                if (sourceTransaction) sourceTransaction.forwarded = true
                const transaction: ServerLifecycleTransaction = sourceTransaction ? {
                  forwarded: true,
                  id: sourceTransaction.id,
                  origin: sourceTransaction.origin,
                  queryId: sourceTransaction.queryId,
                  summary: emptyServerMutationSummary(),
                } : {
                  forwarded: true,
                  id: `internal-${++internalTransactionSequence}`,
                  origin: "unknown",
                  queryId: null,
                  summary: emptyServerMutationSummary(),
                }
                transactions.push(transaction)
                lifecycle.record("forward:begin", {
                  immediate: beginOptions?.immediate === true,
                  origin: transaction.origin,
                  queryId: transaction.queryId,
                  txId: transaction.id,
                })
                params.begin(beginOptions)
              },
              write: (message) => {
                const transaction = transactions.at(-1)
                if (transaction) recordServerMutation(transaction.summary, message)
                lifecycle.record("forward:write", {
                  mutations: { ...(transaction?.summary ?? emptyServerMutationSummary()) },
                  origin: transaction?.origin ?? "unknown",
                  queryId: transaction?.queryId ?? null,
                  txId: transaction?.id ?? "internal-unscoped",
                })
                params.write(message)
              },
              commit: (signal?: AbortSignal) => {
                const transaction = transactions.pop() ?? {
                  forwarded: true,
                  id: `internal-${++internalTransactionSequence}`,
                  origin: "unknown" as const,
                  queryId: null,
                  summary: emptyServerMutationSummary(),
                }
                const detail = {
                  mutations: { ...transaction.summary },
                  origin: transaction.origin,
                  queryId: transaction.queryId,
                  txId: transaction.id,
                }
                return observeCommunityDbLifecycleCommit(
                  (commitSignal) => params.commit(commitSignal),
                  lifecycle.record,
                  "forward",
                  detail,
                )(signal)
              },
              markReady: () => {
                lifecycle.record("forward:mark-ready")
                params.markReady()
              },
              truncate: () => {
                lifecycle.record("forward:truncate")
                params.truncate()
              },
            })
            if (!result || typeof result === "function" || !result.loadSubset) return result
            const loadSubset = result.loadSubset
            return {
              ...result,
              loadSubset: observeCommunityDbLifecycleLoadSubset(
                loadSubset,
                lifecycle.record,
                () => `load-${++loadSubsetSequence}`,
              ),
            }
          },
        },
      }
    : baseServerOptions
  const servers = dbClient.collection(collectionOptions(`community-db:${scopeId}:servers`, () => (
    { ...serverOptions, schema: serverSchema }
  )) as never) as unknown as Collection<
    ServerRow,
    string,
    QueryCollectionUtils<ServerRow, string>,
    typeof serverSchema,
    z.input<typeof serverSchema>
  >
  readServerRows = () => servers.values()
  readServerSyncedRows = () => {
    const state = servers as unknown as {
      _state?: { syncedData?: Map<string, ServerRow> }
    }
    return state._state?.syncedData?.values() ?? []
  }
  const categories = dbClient.collection(collectionOptions(`community-db:${scopeId}:categories`, () => (
    canonicalCollectionOptions(scopeId, "categories", persistence, categorySchema, (row) => row.id)
  )))
  const channels = dbClient.collection(collectionOptions(`community-db:${scopeId}:channels`, () => (
    canonicalCollectionOptions(scopeId, "channels", persistence, channelSchema, (row) => row.id)
  )))
  const serverMemberships = dbClient.collection(collectionOptions(`community-db:${scopeId}:serverMemberships`, () => (
    canonicalCollectionOptions(scopeId, "serverMemberships", persistence, serverMembershipSchema, (row) => row.id)
  )))
  const channelMemberships = dbClient.collection(collectionOptions(`community-db:${scopeId}:channelMemberships`, () => (
    canonicalCollectionOptions(scopeId, "channelMemberships", persistence, channelMembershipSchema, (row) => row.id)
  )))
  const profiles = dbClient.collection(collectionOptions(`community-db:${scopeId}:profiles`, () => (
    canonicalCollectionOptions(scopeId, "profiles", persistence, profileSchema, (row) => row.userId)
  )))
  const messages = dbClient.collection(collectionOptions(`community-db:${scopeId}:messages`, () => (
    canonicalCollectionOptions(scopeId, "messages", persistence, messageSchema, (row) => row.id)
  )))
  const readStates = dbClient.collection(collectionOptions(`community-db:${scopeId}:readStates`, () => (
    canonicalCollectionOptions(scopeId, "readStates", persistence, readStateSchema, (row) => row.channelId)
  )))
  const readStateClock = dbClient.collection(collectionOptions(`community-db:${scopeId}:readStateClock`, () => (
    canonicalCollectionOptions(scopeId, "readStateClock", persistence, readStateClockSchema, (row) => row.id)
  )))
  const attentionScopes = dbClient.collection(collectionOptions(`community-db:${scopeId}:attentionScopes`, () => (
    canonicalCollectionOptions(scopeId, "attentionScopes", persistence, attentionScopeSchema, (row) => row.scopeId)
  )))
  const attentionItems = dbClient.collection(collectionOptions(`community-db:${scopeId}:attentionItems`, () => (
    canonicalCollectionOptions(scopeId, "attentionItems", persistence, attentionItemSchema, (row) => row.id)
  )))
  const folders = dbClient.collection(collectionOptions(`community-db:${scopeId}:folders`, () => (
    canonicalCollectionOptions(scopeId, "folders", persistence, folderSchema, (row) => row.id)
  )))
  const folderItems = dbClient.collection(collectionOptions(`community-db:${scopeId}:folderItems`, () => (
    canonicalCollectionOptions(scopeId, "folderItems", persistence, folderItemSchema, (row) => row.id)
  )))
  const notificationSettings = dbClient.collection(collectionOptions(`community-db:${scopeId}:notificationSettings`, () => (
    canonicalCollectionOptions(scopeId, "notificationSettings", persistence, notificationSettingSchema, (row) => row.id)
  )))

  const collections = {
    servers,
    categories,
    channels,
    serverMemberships,
    channelMemberships,
    profiles,
    messages,
    readStates,
    readStateClock,
    attentionScopes,
    attentionItems,
    folders,
    folderItems,
    notificationSettings,
  } as const
  type CollectionName = keyof typeof collections
  type CollectionReadiness = "not-ready" | "preloading" | "ready" | "failed"
  const collectionNames = Object.keys(collections) as CollectionName[]
  const collectionReadiness = new Map<CollectionName, CollectionReadiness>(
    collectionNames.map((name) => [name, "not-ready"]),
  )
  const collectionPreloads = new Map<CollectionName, Promise<void>>()
  const collectionReadinessListeners = new Set<() => void>()
  const restoredCollectionNames = new Set<CollectionName>()
  const restoredCollectionListeners = new Set<() => void>()
  let restoredDataExists = false
  let readinessVersion = 0
  let generationFailure: unknown = null
  const activeMessageScopes = new Map<string, number>()
  const inactiveMessageScopes = new Map<string, number>()
  let messageScopeClock = 0
  let retentionScheduled = false
  let serverRefetch: Promise<void> | null = null

  const serverRestoreSubscription = persistence
    ? servers.subscribeChanges(() => {
        if (
          servers.size === 0
          || queryClient.getQueryState(serversCollectionQueryKey())?.status === "success"
          || restoredCollectionNames.has("servers")
        ) return
        restoredCollectionNames.add("servers")
        restoredDataExists = true
        for (const listener of restoredCollectionListeners) listener()
      }, { includeInitialState: true })
    : null

  const publishReadiness = () => {
    readinessVersion += 1
    for (const listener of collectionReadinessListeners) listener()
  }

  const failGeneration = (error: unknown) => {
    if (generationFailure !== null) return
    generationFailure = error
    for (const name of collectionNames) collectionReadiness.set(name, "failed")
    serverReadiness = "failed"
    lifecycle?.record("readiness:generation-failed", { failed: true })
    publishReadiness()
  }

  const ensureCollectionReady = (name: CollectionName): Promise<void> => {
    if (generationFailure !== null) return Promise.reject(generationFailure)
    const existing = collectionPreloads.get(name)
    if (existing) return existing

    collectionReadiness.set(name, "preloading")
    if (name === "servers") serverReadiness = "preloading"
    lifecycle?.record("readiness:preloading", { collection: name })
    publishReadiness()
    const promise = Promise.resolve()
      .then(() => collections[name].preload())
      .then(() => {
        if (generationFailure !== null) throw generationFailure
        const restored = collections[name].size > 0
        if (restored) {
          restoredCollectionNames.add(name)
          restoredDataExists = true
        }
        collectionReadiness.set(name, "ready")
        if (name === "servers") serverReadiness = "ready"
        lifecycle?.record("readiness:ready", { collection: name, restored })
        publishReadiness()
        if (restored) {
          for (const listener of restoredCollectionListeners) listener()
        }
      })
      .catch((error) => {
        failGeneration(error)
        throw error
      })
    collectionPreloads.set(name, promise)
    return promise
  }

  const preload = async () => {
    await Promise.all(collectionNames.map(ensureCollectionReady))
    const scopesByNewest = new Map<string, number>()
    for (const message of collections.messages.values()) {
      const order = Date.parse(message.createdAt ?? "") || message.seq || 0
      scopesByNewest.set(message.channelId, Math.max(scopesByNewest.get(message.channelId) ?? 0, order))
    }
    for (const [scopeId] of [...scopesByNewest].sort((a, b) => a[1] - b[1])) {
      if (!activeMessageScopes.has(scopeId) && !inactiveMessageScopes.has(scopeId)) {
        messageScopeClock += 1
        inactiveMessageScopes.set(scopeId, messageScopeClock)
      }
    }
  }

  const requestServerRefetch = () => {
    serverRefetch ??= ensureCollectionReady("servers")
      .then(() => servers.utils.refetch({ throwOnError: true }))
      .then(() => undefined)
      .finally(() => {
        serverRefetch = null
      })
    return serverRefetch
  }

  const pruneMessageRetention = async () => {
    await preload()
    const retainedInactiveScopes = new Set(
      [...inactiveMessageScopes]
        .sort((a, b) => b[1] - a[1])
        .slice(0, INACTIVE_MESSAGE_SCOPE_LIMIT)
        .map(([scopeId]) => scopeId),
    )
    const attentionMessageIds = new Set(
      [...collections.attentionItems.values()].flatMap((item) => (
        item.messageId ? [item.messageId] : []
      )),
    )
    const messagesByScope = new Map<string, MessageRow[]>()
    for (const message of collections.messages.values()) {
      const rows = messagesByScope.get(message.channelId) ?? []
      rows.push(message)
      messagesByScope.set(message.channelId, rows)
    }
    const retainedMessageIds = new Set(attentionMessageIds)
    for (const [scopeId, rows] of messagesByScope) {
      if (activeMessageScopes.has(scopeId)) {
        for (const row of rows) retainedMessageIds.add(row.id)
        continue
      }
      if (!retainedInactiveScopes.has(scopeId)) continue
      rows.sort((a, b) => (
        (b.createdAt ?? "").localeCompare(a.createdAt ?? "")
        || (b.seq ?? 0) - (a.seq ?? 0)
        || b.id.localeCompare(a.id)
      ))
      for (const row of rows.slice(0, INACTIVE_MESSAGE_LIMIT)) {
        retainedMessageIds.add(row.id)
      }
    }
    const deleteIds = [...collections.messages.keys()].filter(
      (messageId) => !retainedMessageIds.has(messageId),
    )
    if (deleteIds.length === 0) return
    const transaction = dbClient.createTransaction({
      mutationFn: async ({ transaction: pending }) => {
        await collections.messages.utils.acceptMutations(pending)
      },
    })
    transaction.mutate(() => collections.messages.delete(deleteIds))
    await transaction.isPersisted.promise
  }

  const activateMessageScope = (scopeId: string) => {
    activeMessageScopes.set(scopeId, (activeMessageScopes.get(scopeId) ?? 0) + 1)
    inactiveMessageScopes.delete(scopeId)
    return () => {
      const remaining = (activeMessageScopes.get(scopeId) ?? 1) - 1
      if (remaining > 0) {
        activeMessageScopes.set(scopeId, remaining)
        return
      }
      activeMessageScopes.delete(scopeId)
      messageScopeClock += 1
      inactiveMessageScopes.set(scopeId, messageScopeClock)
      if (retentionScheduled) return
      retentionScheduled = true
      queueMicrotask(() => {
        retentionScheduled = false
        void pruneMessageRetention().catch(() => {})
      })
    }
  }

  const clear = async () => {
    await preload()
    const serverKeys = [...servers.keys()]
    if (serverKeys.length > 0) {
      servers.utils.writeBatch(() => {
        for (const key of serverKeys) servers.utils.writeDelete(key)
      })
    }
    const mutableCollections = Object.entries(collections)
      .filter(([name]) => name !== "servers")
      .map(([, collection]) => collection) as unknown as Array<{
      keys: () => IterableIterator<string>
      delete: (keys: string[]) => unknown
      utils: {
        acceptMutations: (transaction: {
          mutations: Array<PendingMutation<Record<string, unknown>>>
        }) => Promise<void> | void
      }
    }>
    const transaction = dbClient.createTransaction({
      mutationFn: async ({ transaction: pending }) => {
        await Promise.all(mutableCollections.map((collection) => (
          collection.utils.acceptMutations(pending as unknown as {
            mutations: Array<PendingMutation<Record<string, unknown>>>
          })
        )))
      },
    })
    transaction.mutate(() => {
      for (const collection of mutableCollections) {
        const keys = [...collection.keys()]
        if (keys.length > 0) collection.delete(keys)
      }
    })
    await transaction.isPersisted.promise
  }

  return {
    accountId,
    scopeId,
    queryClient,
    dbClient,
    collections,
    ensureCollectionReady,
    isCollectionReady: (name: CollectionName) => collectionReadiness.get(name) === "ready",
    getCollectionReadiness: (name: CollectionName) => collectionReadiness.get(name)!,
    getCollectionReadinessSnapshot: () => readinessVersion,
    subscribeCollectionReadiness: (listener: () => void) => {
      collectionReadinessListeners.add(listener)
      return () => collectionReadinessListeners.delete(listener)
    },
    isFailed: () => generationFailure !== null,
    assertGenerationActive: () => {
      if (generationFailure !== null) throw generationFailure
    },
    captureRestoredCollections: () => {
      // Compatibility for callers that used the former aggregate preload gate.
      // Restored ownership is now captured inside each collection's readiness
      // promise before that promise can release queued canonical writes.
    },
    hasRestoredCollection: (name: CollectionName) => restoredCollectionNames.has(name),
    hasRestoredData: () => restoredDataExists,
    subscribeRestoredCollections: (listener: () => void) => {
      restoredCollectionListeners.add(listener)
      return () => restoredCollectionListeners.delete(listener)
    },
    captureServerCollectionCommits,
    getLifecycleTimeline: () => lifecycle?.timeline() ?? null,
    preload,
    requestServerRefetch,
    waitForServerRefetch: () => serverRefetch ?? Promise.resolve(),
    activateMessageScope,
    pruneMessageRetention,
    clear,
    cleanup: async () => {
      serverRestoreSubscription?.unsubscribe()
      await dbClient.cleanup()
    },
  }
}

export type CommunityDbRegistry = ReturnType<typeof createCommunityDbRegistry>

const registryByQueryClient = new WeakMap<QueryClient, CommunityDbRegistry>()
export type CommunityDbRegistryBinding = {
  registry: CommunityDbRegistry
  generation: number
}

type CommunityDbRegistryBindingState = {
  generation: number
  current: CommunityDbRegistryBinding | null
  listeners: Set<() => void>
}

const registryBindingStates = new WeakMap<QueryClient, CommunityDbRegistryBindingState>()
let activeRegistry: CommunityDbRegistry | null = null

function registryBindingState(queryClient: QueryClient) {
  let state = registryBindingStates.get(queryClient)
  if (!state) {
    state = { generation: 0, current: null, listeners: new Set() }
    registryBindingStates.set(queryClient, state)
  }
  return state
}

function publishRegistryBinding(state: CommunityDbRegistryBindingState) {
  for (const listener of state.listeners) listener()
}

export function registerCommunityDbRegistry(registry: CommunityDbRegistry) {
  const state = registryBindingState(registry.queryClient)
  const binding = { registry, generation: state.generation + 1 }
  state.generation = binding.generation
  state.current = binding
  registryByQueryClient.set(registry.queryClient, registry)
  activeRegistry = registry
  publishRegistryBinding(state)
  return () => {
    const current = state.current === binding
    if (current) {
      state.current = null
      registryByQueryClient.delete(registry.queryClient)
      publishRegistryBinding(state)
    }
    if (current && activeRegistry === registry) activeRegistry = null
  }
}

export function getCommunityDbRegistry(queryClient: QueryClient) {
  return registryByQueryClient.get(queryClient) ?? null
}

export function applyCommunityServerPatch(
  queryClient: QueryClient,
  serverId: string,
  changes: Record<string, unknown>,
) {
  const registry = getCommunityDbRegistry(queryClient)
  if (!registry) return false
  const supported = Object.entries(changes).every(([field, value]) => {
    if (field === "name" || field === "description") return typeof value === "string"
    if (field === "icon") return value === null || typeof value === "string"
    return false
  })
  if (
    !registry.isCollectionReady("servers")
    || !registry.collections.servers.has(serverId)
    || !supported
  ) {
    void registry.requestServerRefetch().catch(() => {})
    return false
  }
  registry.collections.servers.utils.writeUpdate({ id: serverId, ...changes })
  return true
}

export function deleteCommunityServerRow(
  registry: CommunityDbRegistry,
  serverId: string,
) {
  if (!registry.collections.servers.has(serverId)) return false
  registry.collections.servers.utils.writeDelete(serverId)
  return true
}

export function getCommunityDbRegistryBinding(queryClient: QueryClient) {
  return registryBindingState(queryClient).current
}

export function isCommunityDbRegistryBindingCurrent(
  queryClient: QueryClient,
  binding: CommunityDbRegistryBinding,
) {
  return registryBindingState(queryClient).current === binding
}

export function subscribeCommunityDbRegistryBinding(
  queryClient: QueryClient,
  listener: () => void,
) {
  const state = registryBindingState(queryClient)
  state.listeners.add(listener)
  return () => state.listeners.delete(listener)
}

export function getActiveCommunityDbRegistry() {
  return activeRegistry
}

export async function clearCommunityPersistenceForAccount(accountId: string) {
  if (activeRegistry?.accountId === accountId) {
    await activeRegistry.clear()
    return
  }
  const runtime = await getBrowserPersistenceRuntime()
  if (!runtime.persistence) return
  const queryClient = new QueryClient()
  const registry = createCommunityDbRegistry(queryClient, accountId, {
    persistence: runtime.persistence,
  })
  try {
    await registry.clear()
  } finally {
    registry.cleanup()
    queryClient.clear()
  }
}
