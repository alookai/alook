import type { PendingMutation } from "@tanstack/react-db"
import type { CommunityDbRegistry } from "./collections"

type CollectionName = keyof CommunityDbRegistry["collections"]

export function writeCommunityCollectionRows<T extends object>(
  registry: CommunityDbRegistry,
  name: CollectionName,
  rows: T[],
  getKey: (row: T) => string,
) {
  const collection = registry.collections[name] as unknown as {
    status: string
    has: (key: string) => boolean
    keys: () => IterableIterator<string>
    insert: (rows: T | T[]) => unknown
    update: (key: string, callback: (draft: T) => void) => unknown
    delete: (keys: string | string[]) => unknown
    utils: {
      acceptMutations: (transaction: {
        mutations: Array<PendingMutation<Record<string, unknown>>>
      }) => Promise<void> | void
    }
  }
  if (collection.status !== "ready") return
  const nextKeys = new Set(rows.map(getKey))
  const removed = Array.from(collection.keys()).filter((key) => !nextKeys.has(key))
  const transaction = registry.dbClient.createTransaction({
    mutationFn: async ({ transaction: pending }) => {
      await collection.utils.acceptMutations(pending as unknown as {
        mutations: Array<PendingMutation<Record<string, unknown>>>
      })
    },
  })
  transaction.mutate(() => {
    if (removed.length > 0) collection.delete(removed)
    for (const row of rows) {
      const key = getKey(row)
      if (!collection.has(key)) {
        collection.insert(row)
        continue
      }
      collection.update(key, (draft) => {
        const draftRecord = draft as Record<string, unknown>
        const rowRecord = row as Record<string, unknown>
        for (const field of Object.keys(draftRecord)) {
          if (!(field in rowRecord)) delete draftRecord[field]
        }
        Object.assign(draftRecord, rowRecord)
      })
    }
  })
  void transaction.isPersisted.promise.catch(() => {})
}
