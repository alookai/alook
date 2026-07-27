import { NextRequest } from "next/server"
import { queries, createLogger } from "@alook/shared"
import { getDb } from "@/lib/db"
import { writeError } from "@/lib/middleware/helpers"
import { withCommunityActor } from "@/lib/middleware/community-actor"
import { requireChannelMember, requireDMParticipant } from "@/lib/community/permissions"

const log = createLogger({ service: "community-attachment-download" })

/**
 * RFC 5987 filename encoding for `X-Alook-Filename`. Percent-encodes
 * everything outside the attr-char set so a non-ASCII filename (`图表.png`)
 * round-trips to a client that decodes it before writing to disk.
 */
function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(/['()]/g, escape).replace(/\*/g, "%2A")
}

/**
 * GET /api/community/attachments/:id/download
 *
 * Download an attachment by its id (not its storage key). Response: raw
 * binary body + `Content-Type`, `Content-Length`, `X-Alook-Filename`.
 *
 * Enumeration-safe: every "you can't have this" path returns the same 404
 * ("attachment not found") — pending-vs-persisted, wrong-owner, and a genuine
 * miss are indistinguishable to a prober. A distinct 502 fires only when the
 * row exists but R2 has drifted (infra fault, not a user-facing gate).
 *
 * The body is buffered inside the try/catch so an R2 stream error becomes a
 * structured 500 rather than a truncated 200 the caller can't parse.
 */
export const GET = withCommunityActor(async (_req: NextRequest, ctx) => {
  const attachmentId = ctx.params?.id
  if (!attachmentId) return writeError("attachment not found", 404)

  try {
    const db = getDb(ctx.env.DB)
    const row = await queries.communityAttachment.getAttachmentById(db, attachmentId)
    if (!row) return writeError("attachment not found", 404)

    if (row.messageId === null) {
      // Pending row — only its uploader may see it (round-trip verify).
      if (row.uploaderId !== ctx.userId) return writeError("attachment not found", 404)
    } else {
      // Persisted row — resolve the message scope, then the standard membership
      // gate. Any non-2xx becomes a generic 404 so a prober can't tell
      // "not a member" from "row doesn't exist".
      const message = await queries.communityMessage.getMessage(db, row.messageId)
      if (!message) return writeError("attachment not found", 404)
      if (message.channelId) {
        const gate = await requireChannelMember(db, message.channelId, ctx.userId)
        if (!gate.ok) return writeError("attachment not found", 404)
      } else if (message.dmConversationId) {
        const gate = await requireDMParticipant(db, message.dmConversationId, ctx.userId)
        if (!gate.ok) return writeError("attachment not found", 404)
      } else {
        return writeError("attachment not found", 404)
      }
    }

    const obj = await ctx.env.COMMUNITY_MEDIA.get(row.r2Key)
    if (!obj) return writeError("attachment storage unavailable", 502)

    const contentType = row.contentType || obj.httpMetadata?.contentType || "application/octet-stream"
    const size = row.size ?? obj.size
    const headers: Record<string, string> = {
      "Content-Type": contentType,
      "X-Alook-Filename": encodeRfc5987(row.filename),
    }
    if (typeof size === "number") headers["Content-Length"] = String(size)

    const buffer = await obj.arrayBuffer()
    return new Response(buffer, { headers })
  } catch (err) {
    log.error("attachment_route_failure", {
      route: "attachmentDownload",
      userId: ctx.userId,
      cause: err instanceof Error ? err.stack ?? err.message : String(err),
    })
    return writeError("internal error", 500)
  }
})
