import { NextResponse, type NextRequest } from "next/server"
import { queries, createLogger } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withCommunityActor, requireBot } from "@/lib/middleware/community-actor"
import { resolveTargetForMember, resolveTargetById, resolveErrorResponse } from "@/lib/community/resolve-ref"
import { requireChannelMember, requireDMAccess } from "@/lib/community/permissions"
import { handleAttachmentUpload } from "@/lib/community/upload"

const log = createLogger({ service: "community-agent-attachment-upload" })

/**
 * POST /api/community/attachmentUpload?target=<ref> — moved from
 * /api/community/agent/attachmentUpload (plan §4 MOVE-FLAT, §9 phase 3).
 *
 * Body: multipart/form-data with a single `file` field.
 * Response: `{ id, filename, contentType, size }` — no url, no r2 key (the
 * bot-shaped result: returns a stable pending id, unlike the human upload route
 * which returns a url). Ref-addressed via `?target=<ref>` (kept, not id —
 * Gener #68), so it stays flat and can't fold onto an `[id]` route (Fork B).
 * Bot-only → human actor rejected 403 (`requireBot`, Gener #116). `target` is
 * resolved through `resolveTargetForMember` so the bot's membership +
 * write-permission gate is identical to `send`. Handler body unchanged from the
 * /agent original except the wrapper + identity source (ctx.botUserId →
 * botUserId).
 */
export const POST = withCommunityActor(async (req: NextRequest, ctx) => {
  const gate0 = requireBot(ctx.actor)
  if (!gate0.ok) return gate0.response
  const botUserId = gate0.bot.userId

  // Track any R2 blob written before the D1 insert throws so the catch below
  // can best-effort delete it. Hoisted here so the try/catch can see it.
  let r2KeyToCleanUp: string | null = null

  try {
    const target = req.nextUrl.searchParams.get("target")
    const channelIdParam = req.nextUrl.searchParams.get("channelId")
    if (!target && !channelIdParam) {
      return NextResponse.json({ error: "missing target or channelId query param" }, { status: 400 })
    }

    const db = getDb(ctx.env.DB)

    const resolved = channelIdParam
      ? await resolveTargetById(db, botUserId, channelIdParam)
      : await resolveTargetForMember(db, botUserId, target!)
    if ("error" in resolved) return resolveErrorResponse(resolved)

    let kind: "channel" | "dm"
    let targetId: string
    if (resolved.kind === "dm") {
      const gate = await requireDMAccess(db, resolved.channelId, botUserId)
      if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })
      kind = "dm"
      targetId = resolved.channelId
    } else {
      const gate = await requireChannelMember(db, resolved.channelId, botUserId)
      if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })
      kind = "channel"
      targetId = resolved.channelId
    }

    const result = await handleAttachmentUpload(req, ctx.env, kind, targetId, {
      uploader: "bot",
      uploaderUserId: botUserId,
    })
    if (!result.ok) return result.response

    // R2 blob is committed — remember its key so the D1-throw path can
    // compensate.
    r2KeyToCleanUp = result.r2Key

    const row = await queries.communityAttachment.createPendingAttachment(db, {
      uploaderId: botUserId,
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
  } catch (err) {
    let r2KeyCleaned = false
    if (r2KeyToCleanUp !== null) {
      try {
        await ctx.env.COMMUNITY_MEDIA.delete(r2KeyToCleanUp)
        r2KeyCleaned = true
      } catch (cleanupErr) {
        log.error("attachment_route_r2_cleanup_failed", {
          route: "attachmentUpload",
          botUserId,
          r2Key: r2KeyToCleanUp,
          cleanupErr: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
        })
      }
    }
    log.error("attachment_route_failure", {
      route: "attachmentUpload",
      botUserId,
      r2KeyCleaned,
      cause: err instanceof Error ? err.stack ?? err.message : String(err),
    })
    return NextResponse.json({ error: "internal error", code: "internal" }, { status: 500 })
  }
})
