/// <reference lib="webworker" />
import type { PrecacheEntry, SerwistGlobalConfig } from "serwist"
import { NavigationRoute, Serwist } from "serwist"
import { isPublicAssetResponse, publicFaviconQueryParameter, restrictPublicPrecacheRoutes } from "../lib/service-worker/public-cache"
import { publicWorkerCacheNames } from "../lib/service-worker/cache-identity"
import { createPublicRuntimeCaching } from "../lib/service-worker/public-cache-runtime"

import { clearOutdatedPublicWorkerCaches } from "../lib/service-worker/public-cache-storage"
import { communityShellHash, isCommunityShellAssetRequest, isCommunityShellNavigation, isCommunityShellResponse } from "../lib/service-worker/community-shell"

declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined
  }
}

declare const self: ServiceWorkerGlobalScope

const entries = self.__SW_MANIFEST ?? []
const shells = entries.map(entry => typeof entry === "string" ? entry : entry.url).filter(url => communityShellHash(url))
if (shells.length !== 1) throw new Error("A complete public community shell is required")
const shellUrl = shells[0]

const serwist = new Serwist({
  precacheEntries: entries,
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
      cacheWillUpdate: async ({ request, response }) => (
        new URL(request.url).pathname === shellUrl
          ? await isCommunityShellResponse(request, response, shellUrl)
          : isPublicAssetResponse(request, response)
      ) ? response : null,
    }],
  },
})

restrictPublicPrecacheRoutes(serwist, self.location.origin)
serwist.registerCapture(({ request }) => isCommunityShellAssetRequest(request, self.location.origin, shellUrl), serwist.createHandlerBoundToUrl(shellUrl))
const navigation = new NavigationRoute(serwist.createHandlerBoundToUrl(shellUrl))
const matchNavigation = navigation.match
navigation.match = options => isCommunityShellNavigation(options.request, self.location.origin) && matchNavigation(options)
serwist.registerRoute(navigation)
serwist.addEventListeners()

self.addEventListener("activate", event => event.waitUntil(clearOutdatedPublicWorkerCaches()))
