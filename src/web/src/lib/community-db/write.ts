import { replaceEqualDeep } from "@tanstack/react-query"
import { hasVirtualProps } from "@tanstack/react-db"
import { communityKeys } from "@/lib/query-keys"
import type { CommunityDbRegistry } from "./collections"
import { communityCollectionSchemas, type CommunityCollectionName, type CommunityCollectionRows } from "@alook/shared"

const acceptedViews = new WeakMap<CommunityDbRegistry, {
  indexes: WeakMap<readonly unknown[], Map<CommunityCollectionName, Map<string, unknown>>>
  rows: WeakMap<object, Map<CommunityCollectionName, object | null>>
}>()
type AfterWrite = () => void | Promise<unknown>
type WriteScope = { completions: Promise<void>[]; after: Map<object | string, AfterWrite>; validated: Map<CommunityCollectionName, WeakSet<object>> }
const writeScopes = new WeakMap<CommunityDbRegistry, WriteScope>()

export function withCommunityCollectionWrites<T>(registry: CommunityDbRegistry, publish: () => T, assertCurrent?: () => void): T | Promise<T> {
  if (writeScopes.has(registry)) return publish()
  const generation = registry.runtime.lifecycle.get().generation
  const accountEpoch = registry.runtime.ws.get().profileAccountEpoch
  const guard = assertCurrent ?? (() => {
    if (!registry.runtime.lifecycle.get().active || registry.runtime.lifecycle.get().generation !== generation
      || registry.runtime.ws.get().profileAccountEpoch !== accountEpoch) throw new DOMException("Retired community owner", "AbortError")
  })
  const scope: WriteScope = { completions: [], after: new Map(), validated: new Map() }
  writeScopes.set(registry, scope)
  let result: T
  try { result = publish() }
  catch (error) { void Promise.allSettled(scope.completions); throw error }
  finally { writeScopes.delete(registry) }
  const finish = () => {
    guard()
    let completion: Promise<unknown> | undefined
    for (const after of scope.after.values()) {
      const publish = () => { guard(); return after() }
      if (completion) completion = completion.then(publish)
      else {
        const next = publish()
        if (next instanceof Promise) completion = next
      }
    }
    return completion ? completion.then(() => { guard(); return result }) : result
  }
  return scope.completions.length ? Promise.all(scope.completions).then(finish) : finish()
}

export function afterCommunityCollectionWrites(registry: CommunityDbRegistry, publish: AfterWrite, key: object | string = publish) {
  const scope = writeScopes.get(registry)
  if (scope) scope.after.set(key, () => withCommunityCollectionWrites(registry, publish))
  else return publish()
}

function trackWrite(registry: CommunityDbRegistry, completion: Promise<void>) {
  const scope = writeScopes.get(registry)
  if (scope) { scope.completions.push(completion); void completion.catch(() => undefined) }
  return completion
}

export function parseCommunityCollectionRows<N extends CommunityCollectionName>(registry: CommunityDbRegistry, name: N, rows: readonly unknown[]): CommunityCollectionRows[N][] {
  const scope = writeScopes.get(registry)
  let validated = scope?.validated.get(name)
  if (scope && !validated) { validated = new WeakSet(); scope.validated.set(name, validated) }
  return rows.map(row => {
    if (registry.collections[name].status === "ready" && row !== null && typeof row === "object" && validated?.has(row)) return row as CommunityCollectionRows[N]
    const parsed = communityCollectionSchemas[name].parse(communityRowData(row)) as CommunityCollectionRows[N]
    validated?.add(parsed)
    return parsed
  })
}

export function readCommunityCollectionRow<N extends CommunityCollectionName>(registry: CommunityDbRegistry, name: N, key: string): CommunityCollectionRows[N] | undefined {
  if (!registry.runtime.lifecycle.get().active) return
  let view = acceptedViews.get(registry)
  if (!view) { view = { indexes: new WeakMap(), rows: new WeakMap() }; acceptedViews.set(registry, view) }
  const rows = registry.queryClient.getQueryData<readonly unknown[]>(communityKeys.communityDbCollection(registry.scopeId, name))
  const collection = registry.collections[name]
  let row: unknown
  if (rows) {
    let indexes = view.indexes.get(rows)
    if (!indexes) { indexes = new Map(); view.indexes.set(rows, indexes) }
    let index = indexes.get(name)
    if (!index) {
      const getKey = (row: unknown) => (collection.getKeyFromItem as (row: unknown) => string).call(collection, row)
      index = new Map(rows.filter(value => value !== null && typeof value === "object").map(value => [getKey(value), value]))
      indexes.set(name, index)
    }
    row = index.get(key)
  } else row = collection.get(key)
  if (row === null || typeof row !== "object") return
  let verified = view.rows.get(row)
  if (!verified) { verified = new Map(); view.rows.set(row, verified) }
  if (!verified.has(name)) {
    const parsed = communityCollectionSchemas[name].safeParse(communityRowData(row))
    verified.set(name, parsed.success ? parsed.data : null)
  }
  return (verified.get(name) ?? undefined) as CommunityCollectionRows[N] | undefined
}

function changedRow(previous: unknown, next: object) {
  if (previous === undefined) return next
  const previousData = communityRowData(previous)
  const entries = previousData !== null && typeof previousData === "object" ? Object.entries(previousData) : []
  const fields = Object.fromEntries(entries.filter(([, value]) => value !== undefined))
  const nextFields = Object.fromEntries(Object.entries(next).filter(([, value]) => value !== undefined))
  if (replaceEqualDeep(fields, nextFields) === fields) return
  return { ...Object.fromEntries(entries.filter(([key]) => !(key in next)).map(([key]) => [key, undefined])), ...next }
}

export function writeCommunityCollectionChanges<N extends CommunityCollectionName>(registry: CommunityDbRegistry, name: N, incoming: readonly unknown[], removed: readonly string[] = []) {
  if (!registry.runtime.lifecycle.get().active) throw new DOMException("Retired community owner", "AbortError")
  type Row = CommunityCollectionRows[N]
  const verified = parseCommunityCollectionRows(registry, name, incoming)
  const collection = registry.collections[name] as {
    status: string
    getKeyFromItem: (row: Row) => string
    utils: { writeBatch: (callback: () => void) => Promise<void>; writeDelete: (keys: string[]) => void; writeUpsert: (rows: Row[]) => void }
  }
  const getKey = (row: Row) => collection.getKeyFromItem(row)
  const keys = verified.map(getKey)
  if ([...keys, ...removed].some(key => typeof key !== "string" || key.length === 0) || new Set(keys).size !== keys.length
    || removed.some(key => keys.includes(key))) throw new Error("Invalid canonical row identity")
  const changed = verified.flatMap(row => {
    const next = changedRow(readCommunityCollectionRow(registry, name, getKey(row)), row)
    return next ? [next as Row] : []
  })
  const deletes = [...new Set(removed)].filter(key => readCommunityCollectionRow(registry, name, key) !== undefined)
  if (!changed.length && !deletes.length) return
  if (collection.status !== "ready") {
    const queryKey = communityKeys.communityDbCollection(registry.scopeId, name)
    const previous = registry.queryClient.getQueryData<Row[]>(queryKey) ?? []
    const replacements = new Map(changed.map(row => [getKey(row), row]))
    const deleted = new Set(deletes)
    const next = previous.flatMap(row => {
      const key = getKey(row)
      const replacement = replacements.get(key)
      replacements.delete(key)
      return deleted.has(key) ? [] : [replacement ?? row]
    })
    registry.queryClient.setQueryData(queryKey, [...next, ...replacements.values()])
    return
  }
  return trackWrite(registry, collection.utils.writeBatch(() => {
    if (deletes.length) collection.utils.writeDelete(deletes)
    if (changed.length) collection.utils.writeUpsert(changed)
  }))
}

export function communityRowData(row: unknown) {
  return row !== null && typeof row === "object" && hasVirtualProps(row)
    ? Object.fromEntries(Object.entries(row).filter(([key]) => !["$hasPendingWrites", "$synced", "$origin", "$key", "$collectionId"].includes(key)))
    : row
}

export function writeCommunityCollectionRows<N extends CommunityCollectionName>(
  registry: CommunityDbRegistry,
  name: N,
  rows: readonly unknown[],
  getKey: (row: CommunityCollectionRows[N]) => string,
  options?: { updatedAt: number },
) {
  if (!registry.runtime.lifecycle.get().active) throw new DOMException("Retired community owner", "AbortError")
  type Row = CommunityCollectionRows[N]
  const verified = parseCommunityCollectionRows(registry, name, rows)
  const keys = verified.map(getKey)
  if (keys.some(key => typeof key !== "string" || key.length === 0) || new Set(keys).size !== keys.length) throw new Error("Invalid canonical row identity")
  const collection = registry.collections[name] as {
    status: string
    keys: () => IterableIterator<string>
    getKeyFromItem: (row: Row) => string
    get: (key: string) => Row | undefined
    utils: {
      writeBatch: (callback: () => void) => Promise<void>
      writeDelete: (keys: string[]) => void
      writeUpsert: (rows: Row[]) => void
    }
  }
  const committed = registry.queryClient.getQueryData<Row[]>(communityKeys.communityDbCollection(registry.scopeId, name))
  if (collection.status !== "ready") {
    const next = verified
    registry.queryClient.setQueryData(
      communityKeys.communityDbCollection(registry.scopeId, name),
      next,
      options,
    )
    return
  }
  const previousByKey = committed === undefined ? undefined : new Map(committed.map((row) => [collection.getKeyFromItem(row), row]))
  const nextKeys = new Set(keys)
  const removed = Array.from(previousByKey?.keys() ?? collection.keys()).filter((key) => !nextKeys.has(key))
  const changed = verified.flatMap((row) => {
    const previous = previousByKey === undefined ? collection.get(getKey(row)) : previousByKey.get(getKey(row))
    if (previous === undefined) return [row]
    const previousData = communityRowData(previous)
    const previousEntries = previousData !== null && typeof previousData === "object" ? Object.entries(previousData) : []
    const previousFields = Object.fromEntries(previousEntries.filter(([, value]) => value !== undefined))
    const nextFields = Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined))
    if (replaceEqualDeep(previousFields, nextFields) === previousFields) return []
    const cleared = Object.fromEntries(previousEntries.filter(([key]) => !(key in row)).map(([key]) => [key, undefined]))
    return [{ ...cleared, ...row }]
  })
  if (removed.length === 0 && changed.length === 0) {
    return
  }
  return trackWrite(registry, collection.utils.writeBatch(() => {
    if (removed.length > 0) collection.utils.writeDelete(removed)
    if (changed.length > 0) collection.utils.writeUpsert(changed)
  }))
}
