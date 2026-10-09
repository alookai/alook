import { replaceEqualDeep } from "@tanstack/react-query"
import { hasVirtualProps } from "@tanstack/react-db"
import { communityKeys } from "@/lib/query-keys"
import type { CommunityDbRegistry } from "./collections"

function businessRow<T extends object>(row: T): T {
  return hasVirtualProps(row)
    ? Object.fromEntries(Object.entries(row).filter(([key]) => !key.startsWith("$"))) as T
    : row
}

export function writeCommunityCollectionRows<T extends object>(
  registry: CommunityDbRegistry,
  name: keyof CommunityDbRegistry["collections"],
  rows: T[],
  getKey: (row: T) => string,
) {
  const collection = registry.collections[name] as unknown as {
    status: string
    keys: () => IterableIterator<string>
    getKeyFromItem: (row: T) => string
    get: (key: string) => T | undefined
    utils: {
      writeBatch: (callback: () => void) => void
      writeDelete: (keys: string[]) => void
      writeUpsert: (rows: T[]) => void
    }
  }
  const committed = registry.queryClient.getQueryData<T[]>(communityKeys.communityDbCollection(registry.scopeId, name))
  if (collection.status !== "ready") {
    const previousByKey = new Map((committed ?? []).map((row) => [getKey(row), businessRow(row)]))
    const next = rows.map((row) => ({ ...previousByKey.get(getKey(row)), ...businessRow(row) }))
    registry.queryClient.setQueryData(
      communityKeys.communityDbCollection(registry.scopeId, name),
      next,
    )
    return
  }
  const previousByKey = committed === undefined ? undefined : new Map(committed.map((row) => [collection.getKeyFromItem(row), row]))
  const nextKeys = new Set(rows.map(getKey))
  const removed = Array.from(previousByKey?.keys() ?? collection.keys()).filter((key) => !nextKeys.has(key))
  const changed = rows.map(businessRow).filter((row) => {
    const previous = previousByKey === undefined ? collection.get(getKey(row)) : previousByKey.get(getKey(row))
    if (previous === undefined) return true
    const previousData = businessRow(previous)
    return replaceEqualDeep(previousData, row) !== previousData
  })
  if (removed.length === 0 && changed.length === 0) {
    return
  }
  collection.utils.writeBatch(() => {
    if (removed.length > 0) collection.utils.writeDelete(removed)
    if (changed.length > 0) collection.utils.writeUpsert(changed)
  })
}
