import type { PendingMutation } from "@tanstack/react-db"
import type { CommunityDbRegistry } from "./collections"

type CollectionName = keyof CommunityDbRegistry["collections"]

const pendingCollectionWrites = new WeakMap<object, Promise<void>>()

export function writeCommunityCollectionRows<T extends object>(
  registry: CommunityDbRegistry,
  name: CollectionName,
  rows: T[] | (() => T[]),
  getKey: (row: T) => string,
) {
  const collection = registry.collections[name] as unknown as {
    status: string
    preload: () => Promise<void>
    has: (key: string) => boolean
    keys: () => IterableIterator<string>
    insert: (rows: T | T[], config?: { optimistic?: boolean }) => unknown
    update: (
      key: string,
      config: { optimistic?: boolean },
      callback: (draft: T) => void,
    ) => unknown
    delete: (keys: string | string[], config?: { optimistic?: boolean }) => unknown
    utils: {
      acceptMutations: (transaction: {
        mutations: Array<PendingMutation<Record<string, unknown>>>
      }) => Promise<void> | void
      getLeadershipState?: () => unknown
    }
  }
  const durable = typeof collection.utils.getLeadershipState === "function"
  const operationConfig = { optimistic: !durable }
  const publish = async () => {
    registry.assertGenerationActive()
    const nextRows = typeof rows === "function" ? rows() : rows
    const nextKeys = new Set(nextRows.map(getKey))
    const removed = Array.from(collection.keys()).filter((key) => !nextKeys.has(key))
    const transaction = registry.dbClient.createTransaction({
      mutationFn: async ({ transaction: pending }) => {
        await collection.utils.acceptMutations(pending as unknown as {
          mutations: Array<PendingMutation<Record<string, unknown>>>
        })
      },
    })
    registry.assertGenerationActive()
    transaction.mutate(() => {
      if (removed.length > 0) collection.delete(removed, operationConfig)
      for (const row of nextRows) {
        const key = getKey(row)
        if (!collection.has(key)) {
          collection.insert(row, operationConfig)
          continue
        }
        collection.update(key, operationConfig, (draft) => {
          const draftRecord = draft as Record<string, unknown>
          const rowRecord = row as Record<string, unknown>
          for (const field of Object.keys(draftRecord)) {
            if (!(field in rowRecord)) delete draftRecord[field]
          }
          Object.assign(draftRecord, rowRecord)
        })
      }
    })
    await transaction.isPersisted.promise
  }

  const pending = pendingCollectionWrites.get(collection)
  if (!pending && registry.isCollectionReady(name) && !durable) {
    const immediate = publish()
    void immediate.catch(() => {})
    return immediate
  }

  // A query or WS write can still arrive while a collection is preloading.
  // Preserve those writes and serialize them so an older deferred snapshot can
  // never land after a newer event write. For OPFS, persistence is part of the
  // queue and rows are non-optimistic: paint therefore means the transaction is
  // committed, so an immediate reload cannot outrun the durable write.
  const ready = pending ?? registry.ensureCollectionReady(name)
  const next = ready.then(publish)
  pendingCollectionWrites.set(collection, next)
  next.then(
    () => {
      if (pendingCollectionWrites.get(collection) === next) {
        pendingCollectionWrites.delete(collection)
      }
    },
    () => {
      if (pendingCollectionWrites.get(collection) === next) {
        pendingCollectionWrites.delete(collection)
      }
    },
  )
  void next.catch(() => {})
  return next
}
