import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { queries, type Database } from "@alook/shared"

const PAGE_VIEWER_TTL_MS = 60_000

export function pageHostOrigin(value: string | undefined): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    const loopback = url.hostname === "localhost" || url.hostname.endsWith(".localhost") || url.hostname === "127.0.0.1" || url.hostname === "[::1]"
    if (url.username || url.password || url.hostname.includes("*") || url.pathname !== "/" || url.search || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))) return null
    return url.origin
  } catch { return null }
}

export async function fetchPageHost(
  binding: { fetch(request: Request): Promise<Response> } | undefined,
  origin: string,
  path: string,
  init: RequestInit,
): Promise<Response> {
  if (pageHostOrigin(origin) !== origin) throw new Error("Invalid Page host origin")
  const target = new URL(origin)
  const loopback = target.hostname === "localhost" || target.hostname.endsWith(".localhost") || target.hostname === "127.0.0.1" || target.hostname === "[::1]"
  const url = `${origin}${path}`
  if (process.env.NODE_ENV !== "development" || target.protocol !== "http:" || !loopback) {
    if (!binding) throw new Error("Page host service binding unavailable")
    return binding.fetch(new Request(url, init))
  }
  if (binding) {
    try {
      const response = await binding.fetch(new Request(url, init))
      if (response.ok || (response.status >= 400 && response.status < 500)) return response
      await response.body?.cancel()
    } catch { /* fall back to local dev HTTP endpoint */ }
  }
  return fetch(new Request(url, init))
}

export function pageServiceAuthorized(request: Request, secret: string | undefined): boolean {
  if (!secret || Buffer.byteLength(secret) < 32) return false
  const given = request.headers.get("authorization")
  if (!given?.startsWith("Bearer ")) return false
  const expected = createHash("sha256").update(secret).digest()
  const actual = createHash("sha256").update(given.slice(7)).digest()
  return timingSafeEqual(expected, actual)
}

export function pageTicketHash(token: string): string | null {
  return /^[A-Za-z0-9_-]{43}$/.test(token) ? createHash("sha256").update(token).digest("hex") : null
}

export async function issuePageViewer(db: Database, pageId: string, userId: string, origin: string, nowMs = Date.now()) {
  const page = await queries.communityPage.getReadablePage(db, pageId, userId)
  if (!page) return null
  const token = randomBytes(32).toString("base64url")
  const hash = pageTicketHash(token)!
  const expiresAt = new Date(nowMs + PAGE_VIEWER_TTL_MS).toISOString()
  await queries.communityPage.createPageViewerTicket(db, {
    hash, userId, pageId, origin, expiresAt, now: new Date(nowMs).toISOString(),
  })
  const url = new URL(`/alook/open/${encodeURIComponent(page.artifactId)}`, origin)
  url.hash = new URLSearchParams({ ticket: token }).toString()
  return { embedUrl: url.href, allowedOrigins: [origin], expiresAt }
}
