import type { CommunityDbRegistry } from "./collections"

type CollectionName = keyof CommunityDbRegistry["collections"]
type CollectionPublicationCapture = {
  names: ReadonlySet<CollectionName> | null
  publications: Set<Promise<void>>
}

const pendingCollectionWrites = new WeakMap<object, Promise<void>>()
const capturedCollectionWrites = new WeakMap<CommunityDbRegistry, Set<Promise<void>>[]>()
const capturedCollectionPublications = new WeakMap<
  CommunityDbRegistry,
  CollectionPublicationCapture[]
>()

export function trackCommunityCollectionWrite(
  registry: CommunityDbRegistry,
  write: Promise<void>,
) {
  for (const capture of capturedCollectionWrites.get(registry) ?? []) capture.add(write)
  return write
}

export function pendingCommunityCollectionWrites(
  registry: CommunityDbRegistry,
  names: readonly CollectionName[],
) {
  return names.flatMap((name) => {
    const pending = pendingCollectionWrites.get(registry.collections[name])
    return pending ? [pending] : []
  })
}

function trackCommunityCollectionPublication(
  registry: CommunityDbRegistry,
  name: CollectionName,
  publication: Promise<void>,
) {
  for (const capture of capturedCollectionPublications.get(registry) ?? []) {
    if (!capture.names || capture.names.has(name)) capture.publications.add(publication)
  }
  return publication
}

export function captureCommunityCollectionWrites(
  registry: CommunityDbRegistry,
  publish: () => void,
) {
  const capture = new Set<Promise<void>>()
  const captures = capturedCollectionWrites.get(registry) ?? []
  captures.push(capture)
  capturedCollectionWrites.set(registry, captures)
  try {
    publish()
  } finally {
    captures.pop()
    if (captures.length === 0) capturedCollectionWrites.delete(registry)
  }
  return [...capture]
}

export function captureCommunityCollectionPublications(
  registry: CommunityDbRegistry,
  names: readonly CollectionName[] | null,
  publish: () => void,
) {
  const capture: CollectionPublicationCapture = {
    names: names ? new Set(names) : null,
    publications: new Set(),
  }
  const captures = capturedCollectionPublications.get(registry) ?? []
  captures.push(capture)
  capturedCollectionPublications.set(registry, captures)
  try {
    publish()
  } finally {
    captures.pop()
    if (captures.length === 0) capturedCollectionPublications.delete(registry)
  }
  return [...capture.publications]
}

export function writeCommunityCollectionRows<T extends object>(
  registry: CommunityDbRegistry,
  name: CollectionName,
  rows: T[] | (() => T[]),
  getKey?: (row: T) => string,
) {
  const keyOf = getKey!
  const queryCollection = registry.collections[name] as unknown as {
    keys: () => IterableIterator<string>
    isReady?: () => boolean
    onFirstReady?: (callback: () => void) => () => void
    startSyncImmediate?: () => void
    utils: {
      writeBatch?: (callback: () => void) => void
      writeDelete?: (keys: string | string[]) => void
      writeUpsert?: (rows: T | T[]) => void
    }
  }
  if (
    typeof queryCollection.utils.writeBatch === "function"
    && typeof queryCollection.utils.writeDelete === "function"
    && typeof queryCollection.utils.writeUpsert === "function"
  ) {
    const publish = () => {
      registry.assertGenerationActive()
      const nextRows = typeof rows === "function" ? rows() : rows
      const nextKeys = new Set(nextRows.map(keyOf))
      const removed = [...queryCollection.keys()].filter((key) => !nextKeys.has(key))
      queryCollection.utils.writeBatch!(() => {
        if (removed.length > 0) queryCollection.utils.writeDelete!(removed)
        if (nextRows.length > 0) queryCollection.utils.writeUpsert!(nextRows)
      })
    }
    const startAndPublish = () => {
      registry.assertGenerationActive()
      // On-demand QueryCollections do not create their manual-sync context
      // until sync starts. A persisted wrapper also has an asynchronous
      // hydration boundary before the wrapped QueryCollection installs that
      // context. Try the write immediately so plain QueryCollections keep WS
      // projection synchronous; only the persisted cold-start case waits for
      // the collection's first real ready transition before retrying.
      queryCollection.startSyncImmediate?.()
      try {
        publish()
        return null
      } catch (error) {
        if (
          !(error instanceof Error)
          || error.name !== "SyncNotInitializedError"
          || typeof queryCollection.onFirstReady !== "function"
        ) throw error
        const ready = queryCollection.isReady?.()
          ? Promise.resolve()
          : new Promise<void>((resolve) => {
              const subscription: { unsubscribe?: () => void } = {}
              subscription.unsubscribe = queryCollection.onFirstReady?.(() => {
                subscription.unsubscribe?.()
                resolve()
              })
            })
        return ready.then(publish)
      }
    }
    const pending = pendingCollectionWrites.get(queryCollection)
    let write: Promise<void>
    let queued = pending !== undefined
    try {
      if (pending) {
        write = pending.then(() => startAndPublish() ?? undefined)
      } else {
        const delayed = startAndPublish()
        queued = delayed !== null
        write = delayed ?? Promise.resolve()
      }
    } catch (error) {
      write = Promise.reject(error)
    }
    if (queued) {
      pendingCollectionWrites.set(queryCollection, write)
      write.then(
        () => {
          if (pendingCollectionWrites.get(queryCollection) === write) {
            pendingCollectionWrites.delete(queryCollection)
          }
        },
        () => {
          if (pendingCollectionWrites.get(queryCollection) === write) {
            pendingCollectionWrites.delete(queryCollection)
          }
        },
      )
    }
    trackCommunityCollectionPublication(registry, name, write)
    trackCommunityCollectionWrite(registry, write)
    void write.catch(() => {})
    return write
  }
  throw new Error(`Collection ${name} is not backed by a QueryCollection`)
}
