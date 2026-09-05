import {
  COMMUNITY_REPLICA_PROTOCOL_VERSION,
  communityReplicaBootstrapResponseSchema,
  communityReplicaDeltaResponseSchema,
  communityReplicaIntentResponseSchema,
  communityReplicaScopeKey,
  communityReplicaTextSendIntentSchema,
  type CommunityReplicaBootstrapResponse,
  type CommunityReplicaCoverage,
  type CommunityReplicaDeltaResponse,
  type CommunityReplicaFrontier,
  type CommunityReplicaIntentOutcome,
  type CommunityReplicaIntentResponse,
  type CommunityReplicaOperation,
  type CommunityReplicaScope,
  type CommunityReplicaTextSendIntent,
} from "@alook/shared"
import {
  deleteDB,
  openDB,
  type DBSchema,
  type IDBPDatabase,
  type IDBPObjectStore,
  type StoreNames,
} from "idb"

const REPLICA_DB_VERSION = 1
const REPLICA_DB_PREFIX = `alook-community-replica-v${COMMUNITY_REPLICA_PROTOCOL_VERSION}:`
const REPLICA_INTENT_WAL_PREFIX = `c-replica-v${COMMUNITY_REPLICA_PROTOCOL_VERSION}:intent:`

type ReplicaEntity = Extract<CommunityReplicaOperation, { operation: "remove" }>["entity"]
type ReplicaUpsert<K extends ReplicaEntity["kind"]> = Extract<
  CommunityReplicaOperation,
  { operation: "upsert"; entity: { kind: K } }
>

type ReplicaMeta = {
  key: "snapshot"
  protocolVersion: number
  snapshotId: string
  takenAt: string
}

export type ReplicaEntityRow = {
  key: string
  scopeKey: string
  entity: ReplicaEntity
  value: Record<string, unknown>
}

type ReplicaIntentState =
  | "local-committed"
  | "canonical-accepted"
  | "canonical-transformed"
  | "canonical-rejected"

export type ReplicaIntentRow = {
  intentId: string
  intent: CommunityReplicaTextSendIntent
  state: ReplicaIntentState
  outcome: CommunityReplicaIntentOutcome | null
}

interface CommunityReplicaDB extends DBSchema {
  meta: { key: string; value: ReplicaMeta }
  frontiers: { key: string; value: CommunityReplicaFrontier[number] }
  coverage: { key: string; value: CommunityReplicaCoverage }
  entities: {
    key: string
    value: ReplicaEntityRow
    indexes: { "by-scope": string }
  }
  intents: {
    key: string
    value: ReplicaIntentRow
    indexes: { "by-state": ReplicaIntentState }
  }
}

export type CoveredReplicaProjection = {
  meta: ReplicaMeta
  frontier: CommunityReplicaFrontier
  coverage: CommunityReplicaCoverage[]
  entities: ReplicaEntityRow[]
}

export class CommunityReplicaGapError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CommunityReplicaGapError"
  }
}

const connections = new Map<string, Promise<IDBPDatabase<CommunityReplicaDB>>>()

function databaseName(accountId: string) {
  return `${REPLICA_DB_PREFIX}${encodeURIComponent(accountId)}`
}

function entityKey(scopeKey: string, entity: ReplicaEntity) {
  return `${scopeKey}\u0000${entity.kind}\u0000${entity.id}`
}

function intentWalKey(accountId: string, intentId: string) {
  return `${REPLICA_INTENT_WAL_PREFIX}${accountId}:${intentId}`
}

function writeIntentWal(accountId: string, intent: CommunityReplicaTextSendIntent) {
  if (typeof window === "undefined") return
  localStorage.setItem(intentWalKey(accountId, intent.intentId), JSON.stringify(intent))
}

function removeIntentWal(accountId: string, intentId: string) {
  if (typeof window === "undefined") return
  localStorage.removeItem(intentWalKey(accountId, intentId))
}

export function commitCommunityReplicaIntentWal(
  accountId: string,
  input: unknown,
): CommunityReplicaTextSendIntent {
  const intent = communityReplicaTextSendIntentSchema.parse(input)
  writeIntentWal(accountId, intent)
  return intent
}

export function discardCommunityReplicaIntentWal(accountId: string, intentId: string) {
  removeIntentWal(accountId, intentId)
}

function clearIntentWal(accountId: string) {
  if (typeof window === "undefined") return
  const prefix = `${REPLICA_INTENT_WAL_PREFIX}${accountId}:`
  for (let index = localStorage.length - 1; index >= 0; index--) {
    const key = localStorage.key(index)
    if (key?.startsWith(prefix)) localStorage.removeItem(key)
  }
}

function readIntentWal(accountId: string) {
  if (typeof window === "undefined") return []
  const prefix = `${REPLICA_INTENT_WAL_PREFIX}${accountId}:`
  const intents: CommunityReplicaTextSendIntent[] = []
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index)
    if (!key?.startsWith(prefix)) continue
    try {
      intents.push(communityReplicaTextSendIntentSchema.parse(JSON.parse(localStorage.getItem(key) ?? "")))
    } catch {
      localStorage.removeItem(key)
      index -= 1
    }
  }
  return intents
}

function openReplica(accountId: string) {
  if (typeof indexedDB === "undefined") return null
  let connection = connections.get(accountId)
  if (!connection) {
    connection = openDB<CommunityReplicaDB>(databaseName(accountId), REPLICA_DB_VERSION, {
      upgrade(db) {
        db.createObjectStore("meta", { keyPath: "key" })
        db.createObjectStore("frontiers")
        db.createObjectStore("coverage")
        const entities = db.createObjectStore("entities", { keyPath: "key" })
        entities.createIndex("by-scope", "scopeKey")
        const intents = db.createObjectStore("intents", { keyPath: "intentId" })
        intents.createIndex("by-state", "state")
      },
    })
    connections.set(accountId, connection)
  }
  return connection
}

async function deleteScopeEntities<TxStores extends ArrayLike<StoreNames<CommunityReplicaDB>>>(
  store: IDBPObjectStore<CommunityReplicaDB, TxStores, "entities", "readwrite">,
  scopeKey: string,
) {
  const index = store.index("by-scope")
  let cursor = await index.openCursor(scopeKey)
  while (cursor) {
    await cursor.delete()
    cursor = await cursor.continue()
  }
}

export async function replaceCommunityReplicaBootstrap(
  accountId: string,
  input: unknown,
): Promise<CommunityReplicaBootstrapResponse> {
  const snapshot = communityReplicaBootstrapResponseSchema.parse(input)
  const connection = openReplica(accountId)
  if (!connection) throw new Error("IndexedDB is unavailable")
  const db = await connection
  const tx = db.transaction(["meta", "frontiers", "coverage", "entities", "intents"], "readwrite")
  const entities = tx.objectStore("entities")
  const intents = tx.objectStore("intents")
  const settledIntentIds: string[] = []

  await Promise.all([
    tx.objectStore("frontiers").clear(),
    tx.objectStore("coverage").clear(),
    entities.clear(),
  ])

  for (const item of snapshot.coverage) {
    const key = communityReplicaScopeKey(item.scope)
    await tx.objectStore("coverage").put(item, key)
  }
  for (const entry of snapshot.frontier) {
    await tx.objectStore("frontiers").put(entry, communityReplicaScopeKey(entry.scope))
  }
  for (const fact of snapshot.facts) {
    const scopeKey = communityReplicaScopeKey(fact.scope)
    await entities.put({
      key: entityKey(scopeKey, fact.entity),
      scopeKey,
      entity: fact.entity,
      value: fact.value,
    })
    const nonce = fact.entity.kind === "message"
      ? (fact.value as { clientNonce?: string }).clientNonce
      : null
    if (typeof nonce === "string") {
      await intents.delete(nonce)
      settledIntentIds.push(nonce)
    }
  }
  await tx.objectStore("meta").put({
    key: "snapshot",
    protocolVersion: snapshot.protocolVersion,
    snapshotId: snapshot.snapshotId,
    takenAt: snapshot.takenAt,
  })
  await tx.done
  for (const intentId of settledIntentIds) removeIntentWal(accountId, intentId)
  return snapshot
}

async function invalidateScopes(
  db: IDBPDatabase<CommunityReplicaDB>,
  scopes: CommunityReplicaScope[],
) {
  const tx = db.transaction(["frontiers", "coverage", "entities"], "readwrite")
  const entities = tx.objectStore("entities")
  for (const scope of scopes) {
    const key = communityReplicaScopeKey(scope)
    await deleteScopeEntities(entities, key)
    await tx.objectStore("frontiers").delete(key)
    await tx.objectStore("coverage").delete(key)
  }
  await tx.done
}

function outcomeState(outcome: CommunityReplicaIntentOutcome): ReplicaIntentState {
  if (outcome.status === "accepted") return "canonical-accepted"
  if (outcome.status === "transformed") return "canonical-transformed"
  return "canonical-rejected"
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
}

async function applyOperation<
  EntityTxStores extends ArrayLike<StoreNames<CommunityReplicaDB>>,
  IntentTxStores extends ArrayLike<StoreNames<CommunityReplicaDB>>,
>(
  entities: IDBPObjectStore<CommunityReplicaDB, EntityTxStores, "entities", "readwrite">,
  intents: IDBPObjectStore<CommunityReplicaDB, IntentTxStores, "intents", "readwrite">,
  scopeKey: string,
  operation: CommunityReplicaOperation,
  coverage: CommunityReplicaCoverage,
  settledIntentIds: string[],
) {
  const key = entityKey(scopeKey, operation.entity)
  if (operation.operation === "remove") {
    await entities.delete(key)
    return coverage
  }

  if (operation.entity.kind === "message") {
    const messageOperation = operation as ReplicaUpsert<"message">
    const seq = messageOperation.value.seq
    const range = coverage.messageRange
    if (!positiveInteger(seq) || !range) throw new CommunityReplicaGapError("canonical message is outside covered history")
    if (seq < range.firstSeq || seq > range.lastSeq + 1 || (seq === range.lastSeq + 1 && range.hasNewer)) {
      throw new CommunityReplicaGapError("canonical message sequence is not contiguous with coverage")
    }
    if (seq === range.lastSeq + 1) {
      coverage = { ...coverage, messageRange: { ...range, lastSeq: seq } }
    }
  }

  if (operation.entity.kind === "read-state") {
    const readOperation = operation as ReplicaUpsert<"read-state">
    const current = await entities.get(key)
    const currentSeq = current?.value.lastReadSeq
    const nextSeq = readOperation.value.lastReadSeq
    if (
      typeof nextSeq !== "number"
      || !Number.isInteger(nextSeq)
      || nextSeq < 0
      || (typeof currentSeq === "number" && nextSeq < currentSeq)
    ) {
      throw new CommunityReplicaGapError("canonical read state regressed")
    }
  }

  await entities.put({ key, scopeKey, entity: operation.entity, value: operation.value })
  const nonce = operation.entity.kind === "message"
    ? (operation as ReplicaUpsert<"message">).value.clientNonce
    : null
  if (typeof nonce === "string") {
    await intents.delete(nonce)
    settledIntentIds.push(nonce)
  }
  return coverage
}

export async function applyCommunityReplicaDelta(
  accountId: string,
  input: unknown,
): Promise<CommunityReplicaDeltaResponse> {
  const response = communityReplicaDeltaResponseSchema.parse(input)
  const connection = openReplica(accountId)
  if (!connection) throw new Error("IndexedDB is unavailable")
  const db = await connection
  if (response.status === "rebootstrap") {
    await invalidateScopes(db, response.scopes)
    return response
  }

  const tx = db.transaction(["frontiers", "coverage", "entities", "intents"], "readwrite")
  const entities = tx.objectStore("entities")
  const intents = tx.objectStore("intents")
  try {
    const coverageByScope = new Map<string, CommunityReplicaCoverage>()
    const settledIntentIds: string[] = []
    for (const from of response.from) {
      const key = communityReplicaScopeKey(from.scope)
      const [local, coverage] = await Promise.all([
        tx.objectStore("frontiers").get(key),
        tx.objectStore("coverage").get(key),
      ])
      if (!local || local.revision !== from.revision || !coverage || coverage.revision !== from.revision) {
        throw new CommunityReplicaGapError(`local frontier does not match ${key}@${from.revision}`)
      }
      coverageByScope.set(key, coverage)
    }

    for (const batch of response.batches) {
      for (const delta of batch.deltas) {
        const key = communityReplicaScopeKey(delta.scope)
        let coverage = coverageByScope.get(key)
        if (!coverage || coverage.revision !== delta.fromRevision) {
          throw new CommunityReplicaGapError(`causal batch is not contiguous for ${key}`)
        }
        for (const operation of delta.operations) {
          coverage = await applyOperation(entities, intents, key, operation, coverage, settledIntentIds)
        }
        coverage = { ...coverage, revision: delta.toRevision }
        coverageByScope.set(key, coverage)
      }
    }

    for (const frontier of response.frontier) {
      const key = communityReplicaScopeKey(frontier.scope)
      const coverage = coverageByScope.get(key)
      if (!coverage || coverage.revision !== frontier.revision) {
        throw new CommunityReplicaGapError(`published frontier does not match ${key}@${frontier.revision}`)
      }
      await tx.objectStore("frontiers").put(frontier, key)
      await tx.objectStore("coverage").put(coverage, key)
    }
    await tx.done
    for (const intentId of settledIntentIds) removeIntentWal(accountId, intentId)
    return response
  } catch (error) {
    tx.abort()
    await tx.done.catch(() => undefined)
    throw error
  }
}

export async function readCoveredCommunityReplica(
  accountId: string,
  scopes: CommunityReplicaScope[],
  now = Date.now(),
): Promise<CoveredReplicaProjection | null> {
  const connection = openReplica(accountId)
  if (!connection) return null
  const db = await connection
  const tx = db.transaction(["meta", "frontiers", "coverage", "entities"], "readonly")
  const meta = await tx.objectStore("meta").get("snapshot")
  if (!meta || meta.protocolVersion !== COMMUNITY_REPLICA_PROTOCOL_VERSION) return null

  const frontier: CommunityReplicaFrontier = []
  const coverage: CommunityReplicaCoverage[] = []
  const entities: ReplicaEntityRow[] = []
  for (const scope of scopes) {
    const key = communityReplicaScopeKey(scope)
    const [entry, item, rows] = await Promise.all([
      tx.objectStore("frontiers").get(key),
      tx.objectStore("coverage").get(key),
      tx.objectStore("entities").index("by-scope").getAll(key),
    ])
    if (
      !entry
      || !item
      || item.revision !== entry.revision
      || Date.parse(item.permission.validUntil) <= now
    ) return null
    frontier.push(entry)
    coverage.push(item)
    entities.push(...rows)
  }
  await tx.done
  return { meta, frontier, coverage, entities }
}

export async function persistCommunityReplicaIntent(
  accountId: string,
  input: unknown,
): Promise<ReplicaIntentRow> {
  const intent = communityReplicaTextSendIntentSchema.parse(input)
  const connection = openReplica(accountId)
  if (!connection) throw new Error("IndexedDB is unavailable")
  const db = await connection
  const existing = await db.get("intents", intent.intentId)
  if (existing) {
    if (JSON.stringify(existing.intent) !== JSON.stringify(intent)) {
      throw new Error("intentId is already bound to another payload")
    }
    return existing
  }
  const row: ReplicaIntentRow = {
    intentId: intent.intentId,
    intent,
    state: "local-committed",
    outcome: null,
  }
  await db.put("intents", row)
  return row
}

export async function commitCommunityReplicaIntent(
  accountId: string,
  input: unknown,
): Promise<ReplicaIntentRow> {
  const intent = commitCommunityReplicaIntentWal(accountId, input)
  return persistCommunityReplicaIntent(accountId, intent)
}

export async function listCommunityReplicaIntents(accountId: string) {
  const connection = openReplica(accountId)
  if (!connection) return []
  const db = await connection
  const recovered = readIntentWal(accountId)
  if (recovered.length > 0) {
    const tx = db.transaction("intents", "readwrite")
    for (const intent of recovered) {
      const existing = await tx.store.get(intent.intentId)
      if (!existing) {
        await tx.store.put({
          intentId: intent.intentId,
          intent,
          state: "local-committed",
          outcome: null,
        })
      }
    }
    await tx.done
  }
  return db.getAll("intents")
}

export async function discardCommunityReplicaIntent(accountId: string, intentId: string) {
  removeIntentWal(accountId, intentId)
  const connection = openReplica(accountId)
  if (connection) await (await connection).delete("intents", intentId)
}

export async function applyCommunityReplicaIntentOutcomes(
  accountId: string,
  input: unknown,
): Promise<CommunityReplicaIntentResponse> {
  const response = communityReplicaIntentResponseSchema.parse(input)
  const connection = openReplica(accountId)
  if (!connection) throw new Error("IndexedDB is unavailable")
  const db = await connection
  const tx = db.transaction("intents", "readwrite")
  for (const outcome of response.outcomes) {
    const row = await tx.store.get(outcome.intentId)
    if (!row) throw new Error(`unknown intent outcome ${outcome.intentId}`)
    await tx.store.put({
      ...row,
      state: outcomeState(outcome),
      outcome,
    })
  }
  await tx.done
  return response
}

export async function deleteCommunityReplicaAccount(accountId: string) {
  const connection = connections.get(accountId)
  if (connection) (await connection).close()
  connections.delete(accountId)
  clearIntentWal(accountId)
  if (typeof indexedDB !== "undefined") await deleteDB(databaseName(accountId))
}
