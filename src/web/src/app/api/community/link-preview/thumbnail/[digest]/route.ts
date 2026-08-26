import { NextResponse, type NextRequest } from "next/server"
import { getCloudflareContext } from "@opennextjs/cloudflare"
import { withAuth } from "@/lib/middleware/auth"
import { checkRateLimit } from "@/lib/rate-limit"
import {
  fetchAndTransformLinkPreviewThumbnail,
  isFreshLinkPreviewThumbnailObject,
  isLinkPreviewThumbnailDigest,
  linkPreviewThumbnailNegativeKey,
  linkPreviewThumbnailObjectKey,
  linkPreviewThumbnailObjectMetadata,
  readLinkPreviewThumbnailManifest,
} from "@/lib/community/link-preview-thumbnail"

const NEGATIVE_TTL_SECONDS = 5 * 60
const PRIVATE_THUMBNAIL_CACHE = "private, max-age=21600, immutable"

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
  try {
    manifest = await readLinkPreviewThumbnailManifest({
      bucket: ctx.env.COMMUNITY_MEDIA,
      pageDigest,
    })
  } catch {
    return notFound()
  }
  if (!manifest) return notFound()

  const objectKey = linkPreviewThumbnailObjectKey(pageDigest)
  try {
    const cached = await ctx.env.COMMUNITY_MEDIA.get(objectKey)
    if (cached && isFreshLinkPreviewThumbnailObject(cached, manifest)) {
      return thumbnailResponse(cached.body)
    }
    await cached?.body.cancel().catch(() => {})
  } catch {
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
    if (!images) throw new Error("Images binding unavailable")
    const bytes = await fetchAndTransformLinkPreviewThumbnail(manifest.sourceUrl, images)
    await ctx.env.COMMUNITY_MEDIA.put(
      objectKey,
      bytes,
      linkPreviewThumbnailObjectMetadata(manifest),
    )
    return thumbnailResponse(bytes.slice().buffer as ArrayBuffer)
  } catch {
    if (kv) {
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
} as const
