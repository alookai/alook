import { NextResponse, type NextRequest } from "next/server"
import { queries } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAgentRunnerAuth } from "@/lib/middleware/community-agent-runner-auth"
import { resolveTargetForMember, resolveErrorResponse } from "@/lib/community/resolve-ref"
import { requireChannelMember, requireDMParticipant } from "@/lib/community/permissions"
import { handleAttachmentUpload } from "@/lib/community/upload"

/**
 * POST /api/community/agent/attachmentUpload?target=<ref>
 *
 * Body: multipart/form-data with a single `file` field.
 * Response: `{ id, filename, contentType, size }` — no url, no r2 key.
 *
 * Auth is `withAgentRunnerAuth` (`crk_` bearer via the credential-proxy swap).
 * `target` is resolved through `resolveTargetForMember` so the bot's
 * membership + write-permission gate is identical to `send`.
 */
export const POST = withAgentRunnerAuth(async (req: NextRequest, ctx) => {
  const target = req.nextUrl.searchParams.get("target")
  if (!target) {
    return NextResponse.json({ error: "missing target query param" }, { status: 400 })
  }

  const db = getDb(ctx.env.DB)

  const resolved = await resolveTargetForMember(db, ctx.botUserId, target)
  if ("error" in resolved) return resolveErrorResponse(resolved)

  let kind: "channel" | "dm"
  let targetId: string
  if (resolved.kind === "dm") {
    const gate = await requireDMParticipant(db, resolved.dmConversationId, ctx.botUserId)
    if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })
    kind = "dm"
    targetId = resolved.dmConversationId
  } else {
    const gate = await requireChannelMember(db, resolved.channelId, ctx.botUserId)
    if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })
    kind = "channel"
    targetId = resolved.channelId
  }

  const result = await handleAttachmentUpload(req, ctx.env, kind, targetId, {
    uploader: "bot",
    uploaderUserId: ctx.botUserId,
  })
  if (!result.ok) return result.response

  const row = await queries.communityAttachment.createPendingAttachment(db, {
    uploaderId: ctx.botUserId,
    kind,
    targetId,
    r2Key: result.r2Key,
    filename: result.filename,
    contentType: result.contentType,
    size: result.size,
  })

  return NextResponse.json({
    id: row.id,
    filename: row.filename,
    contentType: result.contentType || "application/octet-stream",
    size: result.size,
  })
})
