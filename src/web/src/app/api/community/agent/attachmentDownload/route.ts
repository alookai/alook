import { NextResponse, type NextRequest } from "next/server"
import { queries, CommunityAgentAttachmentDownloadRequestSchema } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAgentRunnerAuth } from "@/lib/middleware/community-agent-runner-auth"
import { requireChannelMember, requireDMParticipant } from "@/lib/community/permissions"

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
 * POST /api/community/agent/attachmentDownload
 *
 * Body: `{ id }`.
 * Response: raw binary stream + `Content-Type`, `Content-Length`,
 * `X-Alook-Filename` (RFC 5987 percent-encoded).
 *
 * Enumeration-safe: every "you can't have this" path returns the same 404
 * with body "attachment not found" — pending-vs-persisted, wrong-owner, and
 * genuine 404 are indistinguishable to a prober. A distinct 502 fires only
 * when the DB row exists but R2 has drifted (infra fault, not user-facing
 * gate).
 */
export const POST = withAgentRunnerAuth(async (req: NextRequest, ctx) => {
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
  const row = await queries.communityAttachment.getAttachmentById(db, parsed.data.id)
  if (!row) {
    return NextResponse.json({ error: "attachment not found" }, { status: 404 })
  }

  if (row.messageId === null) {
    // Pending row — only the uploading bot may see it (round-trip verify).
    if (row.uploaderId !== ctx.botUserId) {
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
    if (message.channelId) {
      const gate = await requireChannelMember(db, message.channelId, ctx.botUserId)
      if (!gate.ok) return NextResponse.json({ error: "attachment not found" }, { status: 404 })
    } else if (message.dmConversationId) {
      const gate = await requireDMParticipant(db, message.dmConversationId, ctx.botUserId)
      if (!gate.ok) return NextResponse.json({ error: "attachment not found" }, { status: 404 })
    } else {
      return NextResponse.json({ error: "attachment not found" }, { status: 404 })
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

  return new Response(obj.body, { headers })
})
