import { CacheFirst, ExpirationPlugin, NetworkFirst, type RuntimeCaching, type SerwistPlugin } from "serwist"
import { publicWorkerRuntimeCacheNames } from "./cache-identity"
import { isPublicAssetRequest, isPublicAssetResponse, publicRuntimeAssetKind } from "./public-cache"

export type PublicRuntimeLimits = Record<keyof ReturnType<typeof publicWorkerRuntimeCacheNames>, { maxEntries: number; maxAgeSeconds: number }>

function waitForStaleExpiration(expiration: ExpirationPlugin): SerwistPlugin {
  return {
    cachedResponseWillBeUsed: async options => {
      const pending: Promise<unknown>[] = []
      const event = new Proxy(options.event, {
        get(target, property) {
          if (property === "waitUntil") return (promise: Promise<unknown>) => {
            pending.push(promise)
            target.waitUntil(promise)
          }
          return Reflect.get(target, property, target)
        },
      })
      const response = expiration.cachedResponseWillBeUsed({ ...options, event })
      if (!response) await Promise.allSettled(pending)
      return response
    },
    cacheDidUpdate: options => expiration.cacheDidUpdate(options),
  }
}

export function createPublicRuntimeCaching(origin: string, limits: PublicRuntimeLimits): RuntimeCaching[] {
  const names = publicWorkerRuntimeCacheNames()
  for (const kind of ["code", "fonts", "images"] as const) {
    const { maxEntries, maxAgeSeconds } = limits[kind]
    if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0 || !Number.isFinite(maxAgeSeconds) || maxAgeSeconds <= 0) throw new RangeError(`Invalid public runtime limits: ${kind}`)
  }
  return (["code", "fonts", "images"] as const).map<RuntimeCaching>(kind => ({
    method: "GET",
    matcher: ({ request, url }) => isPublicAssetRequest(request, origin) && publicRuntimeAssetKind(url.pathname) === kind,
    handler: new (kind === "images" ? NetworkFirst : CacheFirst)({
      cacheName: names[kind],
      fetchOptions: { credentials: "omit", redirect: "error", ...(kind === "images" ? { cache: "no-cache" as const } : {}) },
      plugins: [
        { cacheWillUpdate: async ({ request, response }) => isPublicAssetResponse(request, response) ? response : null },
        waitForStaleExpiration(new ExpirationPlugin({ ...limits[kind] })),
      ],
    }),
  }))
}
