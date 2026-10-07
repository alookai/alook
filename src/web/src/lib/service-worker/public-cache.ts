import type { Serwist } from "serwist"

const publicIcons = new Set([
  "/alook.svg",
  "/official-server-badge-flat.svg",
  "/apple-touch-icon.png",
  "/icon-192.png",
  "/icon-512.png",
])

export function isPublicAssetPath(pathname: string): boolean {
  return publicIcons.has(pathname) || /^\/_next\/static\/(?:chunks|media)\/[a-zA-Z0-9_./-]+\.(?:js|css|woff2?)$/.test(pathname)
}

export function isPublicAssetRequest(request: Request, origin: string): boolean {
  const url = new URL(request.url)
  return request.method === "GET"
    && url.origin === origin
    && !url.search
    && isPublicAssetPath(url.pathname)
    && request.mode !== "navigate"
    && request.destination !== "document"
    && !request.headers.has("Authorization")
    && !request.headers.has("Cookie")
    && !request.headers.has("RSC")
    && !request.headers.has("Next-Router-State-Tree")
    && !request.headers.has("Next-Router-Prefetch")
    && !request.headers.get("Accept")?.includes("text/x-component")
}

export function isPublicAssetResponse(request: Request, response: Response): boolean {
  const pathname = new URL(request.url).pathname
  const cacheControl = response.headers.get("Cache-Control") ?? ""
  const vary = response.headers.get("Vary") ?? ""
  const type = response.headers.get("Content-Type")?.split(";", 1)[0].trim().toLowerCase()
  if (!isPublicAssetPath(pathname) || response.status !== 200 || response.redirected
    || !/(?:^|,)\s*public\s*(?:,|$)/i.test(cacheControl)
    || /(?:^|,)\s*(?:private|no-store|no-cache)\b/i.test(cacheControl)
    || response.headers.has("Set-Cookie")
    || /(?:^|,)\s*(?:\*|cookie|authorization|rsc|next-router[^,]*)\s*(?:,|$)/i.test(vary)) return false
  if (pathname.endsWith(".js")) return type === "application/javascript" || type === "text/javascript"
  if (pathname.endsWith(".css")) return type === "text/css"
  if (/\.woff2?$/.test(pathname)) return type === "font/woff" || type === "font/woff2" || type === "application/font-woff" || type === "application/octet-stream"
  if (pathname.endsWith(".svg")) return type === "image/svg+xml"
  return type === "image/png"
}

export function restrictPublicPrecacheRoutes(serwist: Pick<Serwist, "routes">, origin: string): void {
  for (const routes of serwist.routes.values()) {
    for (const route of routes) {
      const match = route.match
      route.match = options => isPublicAssetRequest(options.request, origin) ? match(options) : false
    }
  }
}
