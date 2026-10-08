const publicCacheIdentity = { namespace: "alook-public-", version: "v1" } as const

export function publicWorkerCacheNames() {
  return { cacheId: `${publicCacheIdentity.namespace}${publicCacheIdentity.version}`,
    precache: `${publicCacheIdentity.namespace}precache-${publicCacheIdentity.version}` }
}

export function isPublicWorkerCacheName(name: string) {
  return name.startsWith(publicCacheIdentity.namespace)
}
