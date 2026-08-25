import { NextRequest } from "next/server"
import { getCloudflareContext } from "@opennextjs/cloudflare"
import { withAuth } from "@/lib/middleware/auth"
import { writeError, writeJSON } from "@/lib/middleware/helpers"
import { checkRateLimit } from "@/lib/rate-limit"
import { fetchLinkPreview, normalizePublicPreviewUrl } from "@/lib/community/link-preview-fetch"
import type { LinkPreview } from "@/lib/community/link-preview"

const POSITIVE_TTL_SECONDS = 6 * 60 * 60
const NEGATIVE_TTL_SECONDS = 5 * 60
const MAX_REQUEST_BODY_BYTES = 4 * 1024

type CacheEntry = { preview: LinkPreview | null }

class RequestBodyTooLargeError extends Error {}

async function readBoundedJson(req: NextRequest): Promise<unknown> {
  const declaredLength = req.headers.get("content-length")
  if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > MAX_REQUEST_BODY_BYTES) {
    await req.body?.cancel().catch(() => {})
    throw new RequestBodyTooLargeError("request body too large")
  }
  if (!req.body) throw new Error("invalid request body")

  const reader = req.body.getReader()
  const decoder = new TextDecoder()
  let body = ""
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_REQUEST_BODY_BYTES) {
        await reader.cancel()
        throw new RequestBodyTooLargeError("request body too large")
      }
      body += decoder.decode(value, { stream: true })
    }
  } finally {
    reader.releaseLock()
  }
  return JSON.parse(body + decoder.decode())
}

function isLinkPreview(value: unknown): value is LinkPreview {
  if (!value || typeof value !== "object") return false
  const item = value as Record<string, unknown>
  return typeof item.url === "string"
    && typeof item.hostname === "string"
    && typeof item.title === "string"
    && (item.description === undefined || typeof item.description === "string")
    && (item.siteName === undefined || typeof item.siteName === "string")
}

function parseCacheEntry(raw: string): CacheEntry | null {
  try {
    const value = JSON.parse(raw) as { preview?: unknown }
    if (value.preview === null) return { preview: null }
    if (isLinkPreview(value.preview)) return { preview: value.preview }
  } catch {
    // Treat a stale/malformed cache entry as a miss.
  }
  return null
}

async function cacheKey(url: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(url))
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
  return `link-preview:v1:${hex}`
}

/**
 * Independent, authenticated URL-unfurl boundary. It is deliberately not part
 * of message list/send: text paints first, and a slow/failed origin only makes
 * this optional card disappear.
 */
export const POST = withAuth(async (req: NextRequest, ctx) => {
  const rateLimit = await checkRateLimit(ctx.env, "community:linkPreview", ctx.userId)
  if (!rateLimit.allowed) {
    return writeError("rate limited", 429, { "Retry-After": String(rateLimit.retryAfterSec) })
  }

  let raw: unknown
  try {
    raw = await readBoundedJson(req)
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) return writeError("request body too large", 413)
    return writeError("invalid request body", 400)
  }
  const requestedUrl = typeof (raw as { url?: unknown } | null)?.url === "string"
    ? (raw as { url: string }).url
    : ""

  let normalized: string
  try {
    normalized = normalizePublicPreviewUrl(requestedUrl).href
  } catch {
    return writeError("invalid preview URL", 400)
  }

  const key = await cacheKey(normalized)
  const kv = ctx.env.CACHE_KV ?? null
  if (kv) {
    try {
      const cached = await kv.get(key)
      if (cached) {
        const entry = parseCacheEntry(cached)
        if (entry) return writeJSON(entry)
      }
    } catch {
      // KV is memoization only; a cache outage degrades to the bounded fetch.
    }
  }

  let entry: CacheEntry
  try {
    entry = { preview: await fetchLinkPreview(normalized) }
  } catch {
    entry = { preview: null }
  }

  if (kv) {
    const write = kv.put(key, JSON.stringify(entry), {
      expirationTtl: entry.preview ? POSITIVE_TTL_SECONDS : NEGATIVE_TTL_SECONDS,
    }).catch(() => {
      // A cache write failure must never turn a valid message link into an error.
    })
    getCloudflareContext().ctx.waitUntil(write)
  }
  return writeJSON(entry)
})
