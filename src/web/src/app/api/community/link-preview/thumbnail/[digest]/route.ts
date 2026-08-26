import { NextResponse, type NextRequest } from "next/server"
import { getCloudflareContext } from "@opennextjs/cloudflare"
import { withAuth } from "@/lib/middleware/auth"
import { checkRateLimit } from "@/lib/rate-limit"
import { log } from "@/lib/logger"
import {
  fetchAndTransformLinkPreviewThumbnail,
  isFreshLinkPreviewThumbnailObject,
  isLinkPreviewThumbnailDigest,
  LinkPreviewThumbnailFailure,
  linkPreviewThumbnailNegativeKey,
  linkPreviewThumbnailObjectKey,
  linkPreviewThumbnailObjectMetadata,
  readLinkPreviewThumbnailManifest,
} from "@/lib/community/link-preview-thumbnail"

const NEGATIVE_TTL_SECONDS = 5 * 60
const PRIVATE_THUMBNAIL_CACHE = "private, max-age=21600, immutable"
const STORAGE_TIMEOUT_MS = 2_000

function stableStorageCode(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const value = error as { code?: unknown; name?: unknown }
    if ((typeof value.code === "string" || typeof value.code === "number")
      && /^[a-zA-Z0-9_.-]{1,64}$/.test(String(value.code))) {
      return `storage_${String(value.code).toLowerCase()}`
    }
    if (typeof value.name === "string" && /^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(value.name)) {
      return `storage_${value.name.toLowerCase()}`
    }
  }
  return "storage_error"
}

function storageFailure(error: unknown, startedAt: number): LinkPreviewThumbnailFailure {
  return new LinkPreviewThumbnailFailure({
    stage: "storage",
    disposition: "transient",
    code: stableStorageCode(error),
    elapsedMs: Math.max(0, Date.now() - startedAt),
    message: "thumbnail storage operation failed",
  })
}

async function withStorageDeadline<T>(promise: Promise<T>, startedAt: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const observed = promise.catch((error) => {
    throw storageFailure(error, startedAt)
  })
  observed.catch(() => {})
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new LinkPreviewThumbnailFailure({
      stage: "storage",
      disposition: "transient",
      code: "storage_timeout",
      elapsedMs: Math.max(0, Date.now() - startedAt),
      message: "thumbnail storage operation timed out",
    })), STORAGE_TIMEOUT_MS)
  })
  try {
    return await Promise.race([observed, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function logThumbnailFailure(pageDigest: string, error: LinkPreviewThumbnailFailure): void {
  log.error("link_preview_thumbnail_failure", {
    stage: error.stage,
    disposition: error.disposition,
    errorCode: error.code,
    elapsedMs: error.elapsedMs,
    pageDigestPrefix: pageDigest.slice(0, 12),
  })
}

function notFound(): NextResponse {
  return NextResponse.json({ error: "thumbnail not found" }, {
    status: 404,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  })
}

function thumbnailResponse(body: BodyInit): Response {
  return new Response(body, {
    headers: {
      "Content-Type": "image/webp",
      "Content-Disposition": "inline",
      "Cache-Control": PRIVATE_THUMBNAIL_CACHE,
      "X-Content-Type-Options": "nosniff",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Referrer-Policy": "no-referrer",
    },
  })
}

export const GET = withAuth(async (_req: NextRequest, ctx) => {
  const pageDigest = ctx.params?.digest
  if (!isLinkPreviewThumbnailDigest(pageDigest)) return notFound()

  let manifest
  const manifestReadStartedAt = Date.now()
  try {
    manifest = await readLinkPreviewThumbnailManifest({
      bucket: ctx.env.COMMUNITY_MEDIA,
      pageDigest,
    })
  } catch (error) {
    logThumbnailFailure(pageDigest, storageFailure(error, manifestReadStartedAt))
    return notFound()
  }
  if (!manifest) return notFound()

  const objectKey = linkPreviewThumbnailObjectKey(pageDigest)
  const objectReadStartedAt = Date.now()
  try {
    const cached = await ctx.env.COMMUNITY_MEDIA.get(objectKey)
    if (cached && isFreshLinkPreviewThumbnailObject(cached, manifest)) {
      return thumbnailResponse(cached.body)
    }
    await cached?.body.cancel().catch(() => {})
  } catch (error) {
    logThumbnailFailure(pageDigest, storageFailure(error, objectReadStartedAt))
    return notFound()
  }

  const kv = ctx.env.CACHE_KV ?? null
  const negativeKey = linkPreviewThumbnailNegativeKey(pageDigest, manifest.sourceDigest)
  if (kv) {
    try {
      if (await kv.get(negativeKey)) return notFound()
    } catch {
      // Negative caching is best-effort; all expensive work remains bounded.
    }
  }

  const rateLimit = await checkRateLimit(ctx.env, "community:linkPreviewThumbnail", ctx.userId)
  if (!rateLimit.allowed) return notFound()

  try {
    const images = ctx.env.IMAGES
    if (!images) {
      throw new LinkPreviewThumbnailFailure({
        stage: "transform",
        disposition: "transient",
        code: "transform_binding_missing",
        elapsedMs: 0,
        message: "Images binding unavailable",
      })
    }
    const bytes = await fetchAndTransformLinkPreviewThumbnail(manifest.sourceUrl, images)
    const storageStartedAt = Date.now()
    await withStorageDeadline(ctx.env.COMMUNITY_MEDIA.put(
      objectKey,
      bytes,
      linkPreviewThumbnailObjectMetadata(manifest),
    ), storageStartedAt)
    return thumbnailResponse(bytes.slice().buffer as ArrayBuffer)
  } catch (error) {
    const thumbnailFailure = error instanceof LinkPreviewThumbnailFailure
      ? error
      : new LinkPreviewThumbnailFailure({
        stage: "transform",
        disposition: "transient",
        code: "transform_unknown",
        elapsedMs: 0,
        message: "thumbnail generation failed",
      })
    logThumbnailFailure(pageDigest, thumbnailFailure)
    if (kv && thumbnailFailure.disposition === "deterministic") {
      const write = kv.put(negativeKey, "1", { expirationTtl: NEGATIVE_TTL_SECONDS }).catch(() => {
        // A negative-cache outage must not turn an image-only miss into a 500.
      })
      getCloudflareContext().ctx.waitUntil(write)
    }
    return notFound()
  }
})

export const LINK_PREVIEW_THUMBNAIL_RESPONSE_HEADERS = {
  cacheControl: PRIVATE_THUMBNAIL_CACHE,
  storageTimeoutMs: STORAGE_TIMEOUT_MS,
} as const
