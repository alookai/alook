const publicCacheIdentity = { namespace: "alook-public-", version: "v1" } as const

export function publicWorkerCacheNames() {
  return { cacheId: `${publicCacheIdentity.namespace}${publicCacheIdentity.version}`,
    precache: `${publicCacheIdentity.namespace}precache-${publicCacheIdentity.version}` }
}

export function isPublicWorkerCacheName(name: string) {
  return name.startsWith(publicCacheIdentity.namespace)
}

export function publicWorkerRuntimeCacheNames() {
  const { cacheId } = publicWorkerCacheNames()
  return { code: `${cacheId}-blog-code`, fonts: `${cacheId}-blog-fonts`, images: `${cacheId}-blog-images` }
}

export function isPublicWorkerRuntimeCacheName(name: string) {
  return isPublicWorkerCacheName(name) && /^v\d+-blog-(?:code|fonts|images)$/.test(name.slice(publicCacheIdentity.namespace.length))
}
