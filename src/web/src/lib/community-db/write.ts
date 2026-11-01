import { replaceEqualDeep } from "@tanstack/react-query"
import { hasVirtualProps } from "@tanstack/react-db"
import { communityKeys } from "@/lib/query-keys"
import type { CommunityDbRegistry } from "./collections"
import { communityCollectionSchemas, type CommunityCollectionName, type CommunityCollectionRows } from "@alook/shared"

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
  type Row = CommunityCollectionRows[N]
  const verified = rows.map(row => communityCollectionSchemas[name].parse(communityRowData(row))) as Row[]
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
  return collection.utils.writeBatch(() => {
    if (removed.length > 0) collection.utils.writeDelete(removed)
    if (changed.length > 0) collection.utils.writeUpsert(changed)
  })
}
