import { NextResponse, type NextRequest } from "next/server"
import { queries, withD1Retry, createLogger, CommunityAgentAttachmentDownloadRequestSchema } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withCommunityActor, requireBot } from "@/lib/middleware/community-actor"
import { requireChannelMember, requireDMAccess } from "@/lib/community/permissions"

const log = createLogger({ service: "community-agent-attachment-download" })

/**
 * RFC 5987 filename encoding for `X-Alook-Filename`. Percent-encodes
 * everything outside the RFC 5987 attr-char set. The daemon-side client
 * decodes before writing to disk so non-ASCII filenames (`图表.png`) round
 * trip safely.
 */
function encodeRfc5987(value: string): string {
  return encodeURIComponent(value)
    .replace(/['()]/g, escape)
    .replace(/\*/g, "%2A")
}

/**
 * POST /api/community/attachmentDownload
 *
 * Moved from /agent (plan §4 MOVE-FLAT, §9 phase 3); bot-only, human actor →
 * 403 via requireBot.
 *
 * Body: `{ id }`.
 * Response: raw binary body + `Content-Type`, `Content-Length`,
 * `X-Alook-Filename` (RFC 5987 percent-encoded).
 *
 * Enumeration-safe: every "you can't have this" path returns the same 404
 * with body "attachment not found" — pending-vs-persisted, wrong-owner, and
 * genuine 404 are indistinguishable to a prober. A distinct 502 fires only
 * when the DB row exists but R2 has drifted (infra fault, not user-facing
 * gate).
 *
 * The body is buffered (`arrayBuffer`) inside the top-level try/catch so an
 * R2 stream error becomes a structured 500 instead of a truncated 200 the
 * daemon-side helper can't parse. The daemon `callDownload` already
 * buffers via `res.arrayBuffer()` (attachments are capped at 25 MB), so no
 * streaming behavior is lost.
 */
export const POST = withCommunityActor(async (req: NextRequest, ctx) => {
  const gate = requireBot(ctx.actor)
  if (!gate.ok) return gate.response
  const botUserId = gate.bot.userId
  try {
    let raw: unknown
    try {
      raw = await req.json()
    } catch {
      return NextResponse.json({ error: "invalid JSON body" }, { status: 400 })
    }
    const parsed = CommunityAgentAttachmentDownloadRequestSchema.safeParse(raw)
    if (!parsed.success) {
      return NextResponse.json({ error: "invalid payload" }, { status: 400 })
    }

    const db = getDb(ctx.env.DB)
    // `withD1Retry` (D1-armor: no-fallback read; retry to truth). Drives 404.
    const row = await withD1Retry(() => queries.communityAttachment.getAttachmentById(db, parsed.data.id), {
      route: "attachmentDownload",
    })
    if (!row) {
      return NextResponse.json({ error: "attachment not found" }, { status: 404 })
    }

    if (row.messageId === null) {
      // Pending row — only the uploading bot may see it (round-trip verify).
      if (row.uploaderId !== botUserId) {
        return NextResponse.json({ error: "attachment not found" }, { status: 404 })
      }
    } else {
      // Persisted row — resolve target scope, then run the standard membership
      // gate. Rewrite any non-2xx to a generic 404 so a prober can't tell
      // "not a member" from "row doesn't exist".
      const message = await queries.communityMessage.getMessage(db, row.messageId)
      if (!message) {
        return NextResponse.json({ error: "attachment not found" }, { status: 404 })
      }
      const channelType = await queries.communityChannel.getChannelType(db, message.channelId)
      if (channelType === "dm") {
        const gate = await requireDMAccess(db, message.channelId, botUserId)
        if (!gate.ok) return NextResponse.json({ error: "attachment not found" }, { status: 404 })
      } else {
        const gate = await requireChannelMember(db, message.channelId, botUserId)
        if (!gate.ok) return NextResponse.json({ error: "attachment not found" }, { status: 404 })
      }
    }

    const obj = await ctx.env.COMMUNITY_MEDIA.get(row.r2Key)
    if (!obj) {
      // Row exists but R2 has no object — infra fault, distinct from the
      // enumeration-safe 404 above.
      return NextResponse.json({ error: "attachment storage unavailable" }, { status: 502 })
    }

    const contentType = row.contentType || obj.httpMetadata?.contentType || "application/octet-stream"
    const size = row.size ?? obj.size
    const headers: Record<string, string> = {
      "Content-Type": contentType,
      "X-Alook-Filename": encodeRfc5987(row.filename),
    }
    if (typeof size === "number") headers["Content-Length"] = String(size)

    // Buffer here (inside try/catch) so an R2 stream mid-read error surfaces
    // as a structured 500 rather than a truncated 200 the client can't parse.
    const buffer = await obj.arrayBuffer()
    return new Response(buffer, { headers })
  } catch (err) {
    log.error("attachment_route_failure", {
      route: "attachmentDownload",
      botUserId: botUserId,
      cause: err instanceof Error ? err.stack ?? err.message : String(err),
    })
    return NextResponse.json({ error: "internal error", code: "internal" }, { status: 500 })
  }
})
