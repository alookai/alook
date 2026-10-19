/// <reference lib="webworker" />
import type { PrecacheEntry, SerwistGlobalConfig } from "serwist"
import { Serwist } from "serwist"
import { isPublicAssetResponse, publicFaviconQueryParameter, restrictPublicPrecacheRoutes } from "../lib/service-worker/public-cache"
import { publicWorkerCacheNames } from "../lib/service-worker/cache-identity"
import { createPublicRuntimeCaching } from "../lib/service-worker/public-cache-runtime"

import { clearOutdatedPublicWorkerCaches } from "../lib/service-worker/public-cache-storage"

declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined
  }
}

declare const self: ServiceWorkerGlobalScope

const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  cacheId: publicWorkerCacheNames().cacheId,
  clientsClaim: true,
  runtimeCaching: createPublicRuntimeCaching(self.location.origin, {
    code: { maxEntries: 80, maxAgeSeconds: 30 * 24 * 60 * 60 },
    fonts: { maxEntries: 160, maxAgeSeconds: 30 * 24 * 60 * 60 },
    images: { maxEntries: 128, maxAgeSeconds: 7 * 24 * 60 * 60 },
  }),
  precacheOptions: {
    cacheName: publicWorkerCacheNames().precache,
    cleanURLs: false,
    directoryIndex: null,
    ignoreURLParametersMatching: [publicFaviconQueryParameter],
    plugins: [{
      requestWillFetch: async ({ request }) => new Request(request, { credentials: "omit", redirect: "error" }),
      cacheWillUpdate: async ({ request, response }) => isPublicAssetResponse(request, response) ? response : null,
    }],
  },
})

restrictPublicPrecacheRoutes(serwist, self.location.origin)
serwist.addEventListeners()

self.addEventListener("activate", event => event.waitUntil(clearOutdatedPublicWorkerCaches()))
