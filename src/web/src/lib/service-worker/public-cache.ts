import type { Serwist } from "serwist"

const publicAssets = new Set([
  "/alook.svg",
  "/official-server-badge-flat.svg",
  "/apple-touch-icon.png",
  "/icon-192.png",
  "/icon-512.png",
  "/favicon.ico",
  "/manifest.json",
  "/contact/gus-photo.jpeg",
  "/fonts/jgs5/jgs5.ttf",
  "/landing/people/alex.webp",
  "/landing/people/lin.webp",
  "/landing/people/nina.webp",
  "/landing/people/priya.webp",
  "/landing/people/sam.webp",
  "/social/readme-card-58c75311e5ba.png",
])

export const publicFaviconQueryParameter = /^favicon\.[a-z0-9]+\.ico$/

export function isPublicAssetPath(pathname: string): boolean {
  return publicAssets.has(pathname)
    || /^\/_next\/static\/chunks\/[a-zA-Z0-9_./-]+\.(?:js|css)$/.test(pathname)
    || /^\/_next\/static\/[a-zA-Z0-9_-]+\/_(?:buildManifest|clientMiddlewareManifest|ssgManifest)\.js$/.test(pathname)
    || /^\/_next\/static\/media\/pdf\.worker\.min\.[a-zA-Z0-9_-]+\.mjs$/.test(pathname)
    || /^\/_next\/static\/media\/[a-zA-Z0-9_./-]+\.(?:woff2?|ttf|png|jpe?g|webp|svg|ico)$/.test(pathname)
    || publicRuntimeAssetKind(pathname) !== undefined
}

export function publicRuntimeAssetKind(pathname: string): "code" | "fonts" | "images" | undefined {
  if (/^\/blog-static\/_next\/static\/chunks\/[a-zA-Z0-9_./-]+\.(?:js|css)$/.test(pathname)
    || /^\/blog-static\/_next\/static\/[a-zA-Z0-9_-]+\/_(?:buildManifest|clientMiddlewareManifest|ssgManifest)\.js$/.test(pathname)) return "code"
  if (/^\/blog-static\/_next\/static\/media\/[a-zA-Z0-9_./-]+\.(?:woff2?|ttf)$/.test(pathname)) return "fonts"
  if (/^\/blog\/_generated\/[a-f0-9]{16}-(?:480|960)\.webp$/.test(pathname)) return "images"
  if (/^\/blog\/[a-z0-9-]+\/[a-zA-Z0-9_.-]+\.(?:png|jpe?g|webp|svg)$/.test(pathname)) return "images"
}

export function isPublicAssetRequest(request: Request, origin: string): boolean {
  const url = new URL(request.url)
  return request.method === "GET"
    && url.origin === origin
    && (!url.search || (url.pathname === "/favicon.ico" && publicFaviconQueryParameter.test(url.search.slice(1))))
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
  if (/\.m?js$/.test(pathname)) return type === "application/javascript" || type === "text/javascript"
  if (pathname.endsWith(".css")) return type === "text/css"
  if (/\.woff2?$/.test(pathname)) return type === "font/woff" || type === "font/woff2" || type === "application/font-woff" || type === "application/octet-stream"
  if (pathname.endsWith(".ttf")) return type === "font/ttf" || type === "application/x-font-ttf" || type === "application/font-sfnt"
  if (pathname.endsWith(".svg")) return type === "image/svg+xml"
  if (/\.jpe?g$/.test(pathname)) return type === "image/jpeg"
  if (pathname.endsWith(".webp")) return type === "image/webp"
  if (pathname.endsWith(".ico")) return type === "image/x-icon" || type === "image/vnd.microsoft.icon"
  if (pathname === "/manifest.json") return type === "application/manifest+json" || type === "application/json"
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
