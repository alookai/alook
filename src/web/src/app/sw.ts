/// <reference lib="webworker" />
import type { PrecacheEntry, SerwistGlobalConfig } from "serwist"
import { Serwist } from "serwist"
import { isPublicAssetResponse, restrictPublicPrecacheRoutes } from "../lib/service-worker/public-cache"

declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined
  }
}

declare const self: ServiceWorkerGlobalScope

const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  cacheId: "alook-public-v1",
  clientsClaim: true,
  precacheOptions: {
    cacheName: "alook-public-precache-v1",
    cleanURLs: false,
    directoryIndex: null,
    ignoreURLParametersMatching: [],
    plugins: [{
      requestWillFetch: async ({ request }) => new Request(request, { credentials: "omit", redirect: "error" }),
      cacheWillUpdate: async ({ request, response }) => isPublicAssetResponse(request, response) ? response : null,
    }],
  },
})

restrictPublicPrecacheRoutes(serwist, self.location.origin)
serwist.addEventListeners()
