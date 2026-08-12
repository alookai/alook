import { NextResponse, type NextRequest } from "next/server"
import { createLogger } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withCommunityActor } from "@/lib/middleware/community-actor"
import { authorizeAttachment } from "@/lib/community/attachment-authorization"
import { ATTACHMENT_PRIVATE_IMMUTABLE_CACHE } from "@/lib/community/storage"

const log = createLogger({ service: "community-attachment-thumbnail-download" })

export const GET = withCommunityActor(async (_req: NextRequest, ctx) => {
  const attachmentId = ctx.params?.attachmentId
  if (!attachmentId) {
    return NextResponse.json({ error: "attachment not found" }, { status: 404 })
  }

  try {
    const authz = await authorizeAttachment(ctx.actor, getDb(ctx.env.DB), attachmentId)
    if (!authz.ok || authz.row.thumbnailR2Key === null) {
      return NextResponse.json({ error: "attachment not found" }, { status: 404 })
    }

    const obj = await ctx.env.COMMUNITY_MEDIA.get(authz.row.thumbnailR2Key)
    if (!obj) {
      return NextResponse.json({ error: "attachment storage unavailable" }, { status: 502 })
    }

    return new Response(obj.body, {
      headers: {
        "Content-Type": "image/jpeg",
        "Content-Disposition": "inline",
        "Cache-Control": ATTACHMENT_PRIVATE_IMMUTABLE_CACHE,
        "X-Content-Type-Options": "nosniff",
      },
    })
  } catch (err) {
    log.error("attachment_thumbnail_route_failure", {
      route: "channels/[id]/attachments/[attachmentId]/thumbnail",
      actorKind: ctx.actor.kind,
      userId: ctx.actor.userId,
      cause: err instanceof Error ? err.stack ?? err.message : String(err),
    })
    return NextResponse.json({ error: "internal error", code: "internal" }, { status: 500 })
  }
})
