import { getCloudflareContext } from "@opennextjs/cloudflare"
import { createLogger, MAX_INLINE_IMAGE_SIZE_BYTES, COMMUNITY_IMAGE_REVISION } from "@alook/shared"

const log = createLogger({ service: "community-image-processing" })
const REVISION = String(COMMUNITY_IMAGE_REVISION)
const VARIANTS = { attachment: 640, identity: 256, preview: 2560 } as const
export const MAX_IMAGE_PROCESSING_BYTES = MAX_INLINE_IMAGE_SIZE_BYTES

export class ImageProcessingError extends Error {
  constructor(readonly reason: "too_large" | "unavailable") {
    super(reason === "too_large" ? "Image exceeds the processing limit" : "Image preview unavailable")
  }
}

export async function createCommunityImageResponse({
  request, env, source, sourceKey, variant, cacheControl,
}: {
  request: Request
  env: Pick<Env, "IMAGES">
  source: Pick<R2ObjectBody, "body" | "size" | "httpEtag">
  sourceKey: string
  variant: keyof typeof VARIANTS
  cacheControl: string
}): Promise<Response> {
  if (source.size > MAX_IMAGE_PROCESSING_BYTES) {
    await source.body.cancel()
    throw new ImageProcessingError("too_large")
  }
  const identity = new TextEncoder().encode(JSON.stringify([REVISION, sourceKey, source.httpEtag, variant]))
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", identity)), byte => byte.toString(16).padStart(2, "0")).join("")
  const etag = `"image-${digest}"`
  const headers = {
    "Cache-Control": cacheControl,
    "Content-Disposition": "inline",
    "X-Content-Type-Options": "nosniff",
    "ETag": etag,
  }
  if (request.headers.get("If-None-Match") === etag) {
    await source.body.cancel()
    return new Response(null, { status: 304, headers })
  }

  const cacheKey = new Request(new URL(`/__private-community-images/${REVISION}/${digest}`, request.url))
  let cache: Cache | undefined
  try {
    if (typeof caches !== "undefined") cache = await caches.open("community-derived-images")
    const cached = await cache?.match(cacheKey)
    if (cached) {
      await source.body.cancel()
      const response = new Response(cached.body, cached)
      for (const [key, value] of Object.entries(headers)) response.headers.set(key, value)
      return response
    }
  } catch (error) {
    log.warn("community_image_cache_read_failed", { errorCategory: error instanceof Error ? error.name : "unknown" })
  }

  let response: Response
  try {
    const edge = VARIANTS[variant]
    if (!env.IMAGES) throw new ImageProcessingError("unavailable")
    const image = await env.IMAGES.input(source.body)
      .transform({ width: edge, height: edge, fit: "scale-down" })
      .output({ format: "image/webp", quality: 85, anim: true })
    response = image.response({ headers })
  } catch (error) {
    log.warn("community_image_transform_failed", {
      variant,
      errorCategory: error instanceof Error ? error.name : "unknown",
    })
    if (!source.body.locked) await source.body.cancel().catch(() => undefined)
    throw new ImageProcessingError("unavailable")
  }

  if (cache) {
    try {
      const { ctx } = await getCloudflareContext({ async: true })
      const stored = response.clone()
      stored.headers.set("Cache-Control", "public, max-age=86400")
      ctx.waitUntil(cache.put(cacheKey, stored).catch((error: unknown) => {
        log.warn("community_image_cache_write_failed", { errorCategory: error instanceof Error ? error.name : "unknown" })
      }))
    } catch (error) {
      log.warn("community_image_cache_write_unavailable", { errorCategory: error instanceof Error ? error.name : "unknown" })
    }
  }
  return response
}
