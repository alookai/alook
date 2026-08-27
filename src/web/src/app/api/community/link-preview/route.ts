import { NextRequest } from "next/server"
import { getCloudflareContext } from "@opennextjs/cloudflare"
import { withAuth } from "@/lib/middleware/auth"
import { writeError, writeJSON } from "@/lib/middleware/helpers"
import { checkRateLimit } from "@/lib/rate-limit"
import { log } from "@/lib/logger"
import {
  fetchLinkPreview,
  LinkPreviewFetchError,
  normalizePublicPreviewUrl,
} from "@/lib/community/link-preview-fetch"
import {
  linkPreviewPageDigest,
  linkPreviewThumbnailUrl,
  writeLinkPreviewThumbnailManifest,
} from "@/lib/community/link-preview-thumbnail"
import type { LinkPreview } from "@/lib/community/link-preview"

const POSITIVE_TTL_SECONDS = 6 * 60 * 60
const NEGATIVE_TTL_SECONDS = 5 * 60
const MAX_REQUEST_BODY_BYTES = 4 * 1024

type CacheEntry = {
  preview: LinkPreview | null
  staleTimeSeconds: typeof POSITIVE_TTL_SECONDS | typeof NEGATIVE_TTL_SECONDS
}

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

function isLinkPreview(value: unknown, expectedDigest: string): value is LinkPreview {
  if (!value || typeof value !== "object") return false
  const item = value as Record<string, unknown>
  return typeof item.url === "string"
    && typeof item.hostname === "string"
    && typeof item.title === "string"
    && (item.description === undefined || typeof item.description === "string")
    && (item.siteName === undefined || typeof item.siteName === "string")
    && (item.thumbnailUrl === undefined
      || item.thumbnailUrl === linkPreviewThumbnailUrl(expectedDigest))
}

function parseCacheEntry(raw: string, expectedDigest: string): CacheEntry | null {
  try {
    const value = JSON.parse(raw) as { preview?: unknown; staleTimeSeconds?: unknown }
    if (value.preview === null && value.staleTimeSeconds === NEGATIVE_TTL_SECONDS) {
      return { preview: null, staleTimeSeconds: NEGATIVE_TTL_SECONDS }
    }
    if (isLinkPreview(value.preview, expectedDigest)
      && (value.staleTimeSeconds === POSITIVE_TTL_SECONDS
        || value.staleTimeSeconds === NEGATIVE_TTL_SECONDS)) {
      return { preview: value.preview, staleTimeSeconds: value.staleTimeSeconds }
    }
  } catch {
    // Treat a stale/malformed cache entry as a miss.
  }
  return null
}

function cacheKey(pageDigest: string): string {
  return `link-preview:v2:${pageDigest}`
}

function elapsedSince(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt)
}

function logLinkPreviewFailure(fields: {
  stage: string
  errorCode: string
  elapsedMs: number
  disposition: "negative_cache" | "text_only_recovery_ttl"
  pageDigestPrefix: string
  httpStatus?: number
}) {
  log.error("link_preview_failure", fields)
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

  const pageDigest = await linkPreviewPageDigest(normalized)
  const key = cacheKey(pageDigest)
  const kv = ctx.env.CACHE_KV ?? null
  if (kv) {
    try {
      const cached = await kv.get(key)
      if (cached) {
        const entry = parseCacheEntry(cached, pageDigest)
        if (entry) return writeJSON(entry)
      }
    } catch {
      // KV is memoization only; a cache outage degrades to the bounded fetch.
    }
  }

  let entry: CacheEntry
  const metadataStartedAt = Date.now()
  try {
    const fetched = await fetchLinkPreview(normalized)
    const { thumbnailSource, ...preview } = fetched
    let staleTimeSeconds: CacheEntry["staleTimeSeconds"] = POSITIVE_TTL_SECONDS
    if (thumbnailSource) {
      const manifestStartedAt = Date.now()
      try {
        await writeLinkPreviewThumbnailManifest({
          bucket: ctx.env.COMMUNITY_MEDIA,
          pageDigest,
          sourceUrl: thumbnailSource,
        })
        preview.thumbnailUrl = linkPreviewThumbnailUrl(pageDigest)
      } catch {
        logLinkPreviewFailure({
          stage: "manifest_write",
          errorCode: "manifest_write_failed",
          elapsedMs: elapsedSince(manifestStartedAt),
          disposition: "text_only_recovery_ttl",
          pageDigestPrefix: pageDigest.slice(0, 12),
        })
        // A capability is exposed only after its strongly-consistent manifest
        // exists. Retry this degraded text-only preview after the negative TTL.
        staleTimeSeconds = NEGATIVE_TTL_SECONDS
      }
    }
    entry = { preview, staleTimeSeconds }
  } catch (error) {
    const failure = error instanceof LinkPreviewFetchError ? error : null
    logLinkPreviewFailure({
      stage: failure?.stage ?? "metadata_fetch",
      errorCode: failure?.code ?? "unexpected_error",
      elapsedMs: elapsedSince(metadataStartedAt),
      disposition: "negative_cache",
      pageDigestPrefix: pageDigest.slice(0, 12),
      ...(failure?.httpStatus === undefined ? {} : { httpStatus: failure.httpStatus }),
    })
    entry = { preview: null, staleTimeSeconds: NEGATIVE_TTL_SECONDS }
  }

  if (kv) {
    const write = kv.put(key, JSON.stringify(entry), {
      expirationTtl: entry.staleTimeSeconds,
    }).catch(() => {
      // A cache write failure must never turn a valid message link into an error.
    })
    getCloudflareContext().ctx.waitUntil(write)
  }
  return writeJSON(entry)
})
