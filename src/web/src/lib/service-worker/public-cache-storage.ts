import { isPublicWorkerCacheName, publicWorkerCacheNames } from "./cache-identity"

function assertRead(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException("Cancelled public cache read", "AbortError")
}

export async function getPublicWorkerCacheSizeBytes(signal?: AbortSignal): Promise<number> {
  assertRead(signal)
  if (typeof caches === "undefined") return 0
  const names = await caches.keys()
  let bytes = 0
  for (const name of names.filter(isPublicWorkerCacheName)) {
    assertRead(signal)
    const cache = await caches.open(name)
    for (const request of await cache.keys()) {
      assertRead(signal)
      const response = await cache.match(request)
      if (response) bytes += (await response.clone().arrayBuffer()).byteLength
    }
  }
  assertRead(signal)
  return bytes
}

async function deletePublicWorkerCaches(keep: (name: string) => boolean): Promise<void> {
  if (typeof caches === "undefined") return
  const names = await caches.keys()
  const results = await Promise.allSettled(names.filter(name => isPublicWorkerCacheName(name) && !keep(name)).map(name => caches.delete(name)))
  for (const result of results) if (result.status === "rejected") throw result.reason
}

export function clearPublicWorkerCaches(): Promise<void> {
  return deletePublicWorkerCaches(() => false)
}

export function clearOutdatedPublicWorkerCaches(): Promise<void> {
  const current = publicWorkerCacheNames()
  return deletePublicWorkerCaches(name => name === current.precache || name === current.cacheId || name.startsWith(`${current.cacheId}-`))
}
