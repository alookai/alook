const COMMUNITY_SHELL_CACHE = "alook-community-shell-v1"
const COMMUNITY_PATH_PREFIX = "/c"
const COMMUNITY_SHELL_PROTOCOL_VERSION = 1

function canonicalCommunityUrl(input) {
  const url = new URL(input, self.location.origin)
  if (url.origin !== self.location.origin) return null
  if (url.pathname !== COMMUNITY_PATH_PREFIX && !url.pathname.startsWith(`${COMMUNITY_PATH_PREFIX}/`)) return null
  url.hash = ""
  url.search = ""
  return url
}

function isRscRequest(request) {
  const url = new URL(request.url)
  return url.searchParams.has("_rsc")
    || request.headers.get("rsc") === "1"
    || request.headers.has("next-router-prefetch")
}

function shellAssetUrls(html, documentUrl) {
  const urls = new Set()
  const attributes = html.matchAll(/(?:src|href)=["']([^"']+)["']/g)
  for (const match of attributes) {
    const value = match[1]
    if (!value || value.startsWith("data:")) continue
    const url = new URL(value, documentUrl)
    if (url.origin !== self.location.origin) continue
    if (url.pathname.startsWith("/api/") || url.searchParams.has("_rsc")) continue
    if (
      url.pathname.startsWith("/_next/static/")
      || /\.(?:css|js|json|png|svg|webp|woff2?|ttf)$/.test(url.pathname)
    ) {
      url.hash = ""
      urls.add(url.href)
    }
  }
  return [...urls]
}

async function stageCommunityRoute(input) {
  const url = canonicalCommunityUrl(input)
  if (!url) throw new Error("unsupported-route")

  const documentResponse = await fetch(url.href, {
    credentials: "same-origin",
    headers: { accept: "text/html" },
    redirect: "error",
  })
  if (!documentResponse.ok || !documentResponse.headers.get("content-type")?.includes("text/html")) {
    throw new Error("route-unavailable")
  }

  const html = await documentResponse.clone().text()
  const assets = shellAssetUrls(html, url.href)
  const assetResponses = await Promise.all(assets.map(async (assetUrl) => {
    const response = await fetch(assetUrl, { credentials: "same-origin" })
    if (!response.ok) throw new Error("asset-unavailable")
    return [assetUrl, response]
  }))

  const cache = await caches.open(COMMUNITY_SHELL_CACHE)
  await Promise.all(assetResponses.map(([assetUrl, response]) => cache.put(assetUrl, response)))
  await cache.put(url.href, documentResponse)
  return { route: url.href, assets: assets.length }
}

async function cachedCommunityResponse(request) {
  const cache = await caches.open(COMMUNITY_SHELL_CACHE)
  const canonical = canonicalCommunityUrl(request.url)
  if (!canonical) return null
  return cache.match(canonical.href)
}

async function clearCommunityDocuments() {
  const cache = await caches.open(COMMUNITY_SHELL_CACHE)
  const requests = await cache.keys()
  await Promise.all(requests.map((request) => {
    const url = canonicalCommunityUrl(request.url)
    return url ? cache.delete(request) : Promise.resolve(false)
  }))
}

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting())
})

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener("message", (event) => {
  const reply = (payload) => event.ports[0]?.postMessage(payload)
  if (event.data?.type === "CACHE_COMMUNITY_ROUTE") {
    if (event.data.protocolVersion !== COMMUNITY_SHELL_PROTOCOL_VERSION) {
      reply({ ok: false, error: "unsupported-protocol" })
      return
    }
    event.waitUntil(
      stageCommunityRoute(event.data.url)
        .then((result) => reply({ ok: true, protocolVersion: COMMUNITY_SHELL_PROTOCOL_VERSION, ...result }))
        .catch((error) => reply({ ok: false, error: error instanceof Error ? error.message : "cache-failed" })),
    )
    return
  }
  if (event.data?.type === "CLEAR_COMMUNITY_ROUTES") {
    event.waitUntil(
      clearCommunityDocuments()
        .then(() => reply({ ok: true, protocolVersion: COMMUNITY_SHELL_PROTOCOL_VERSION }))
        .catch(() => reply({ ok: false, error: "clear-failed" })),
    )
  }
})

self.addEventListener("fetch", (event) => {
  const request = event.request
  if (request.method !== "GET") return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/") || isRscRequest(request)) return

  if (request.mode === "navigate" && canonicalCommunityUrl(request.url)) {
    event.respondWith((async () => {
      const cached = await cachedCommunityResponse(request)
      if (!cached) return fetch(request)
      event.waitUntil(stageCommunityRoute(request.url).catch(() => undefined))
      return cached
    })())
    return
  }

  if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith((async () => {
      const cache = await caches.open(COMMUNITY_SHELL_CACHE)
      return await cache.match(request) ?? fetch(request)
    })())
  }
})
