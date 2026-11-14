import { withAuth } from "@/lib/middleware/auth-policy"
import { NextResponse, type NextRequest } from "next/server"
import { createLogger } from "@alook/shared"
import { getPrimaryDb } from "@/lib/db"
import { communityActorPolicy } from "@/lib/middleware/community-actor"
import { withPrivateMediaCache } from "@/lib/middleware/private-media-cache"
import { authorizeAttachment } from "@/lib/community/attachment-authorization"
import { ATTACHMENT_PRIVATE_IMMUTABLE_CACHE } from "@/lib/community/storage"
import { createCommunityImageResponse, ImageProcessingError } from "@/lib/community/image-processing"
import { isInlineAttachmentContentType } from "@/lib/community/attachment-content-type"

const log = createLogger({ service: "community-attachment-thumbnail-download" })

export const GET = withPrivateMediaCache(withAuth(communityActorPolicy(), async (req: NextRequest, ctx) => {
  const attachmentId = ctx.params?.attachmentId
  if (!attachmentId) {
    return NextResponse.json({ error: "attachment not found" }, { status: 404 })
  }

  try {
    const authz = await authorizeAttachment(ctx.actor, getPrimaryDb(ctx.env.DB), attachmentId)
    if (!authz.ok || !isInlineAttachmentContentType(authz.row.contentType)) {
      return NextResponse.json({ error: "attachment not found" }, { status: 404 })
    }

    const variant = req.nextUrl.searchParams.get("variant")
    if (variant !== null && variant !== "preview") return NextResponse.json({ error: "invalid image variant" }, { status: 400 })
    const obj = await ctx.env.COMMUNITY_MEDIA.get(authz.row.r2Key)
    if (!obj) {
      return NextResponse.json({ error: "attachment storage unavailable" }, { status: 502 })
    }

    return await createCommunityImageResponse({
      request: req, env: ctx.env, source: obj, sourceKey: authz.row.r2Key,
      variant: variant === "preview" ? "preview" : "attachment",
      cacheControl: ATTACHMENT_PRIVATE_IMMUTABLE_CACHE,
    })
  } catch (err) {
    if (err instanceof ImageProcessingError) return NextResponse.json({
      error: err.message,
      code: err.reason === "too_large" ? "image_processing_limit" : "image_processing_unavailable",
    }, { status: err.reason === "too_large" ? 422 : 502 })
    log.error("attachment_thumbnail_route_failure", {
      route: "channels/[id]/attachments/[attachmentId]/thumbnail",
      actorKind: ctx.actor.kind,
      userId: ctx.actor.userId,
      cause: err instanceof Error ? err.stack ?? err.message : String(err),
    })
    return NextResponse.json({ error: "internal error", code: "internal" }, { status: 500 })
  }
}))
