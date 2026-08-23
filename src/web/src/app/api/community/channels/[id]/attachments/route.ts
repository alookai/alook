import { NextResponse, type NextRequest } from "next/server"
import { queries, createLogger } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withCommunityActor, requireBot, type CommunityActor } from "@/lib/middleware/community-actor"
import { resolveTargetForMember, resolveErrorResponse } from "@/lib/community/resolve-ref"
import { requireChannelMember, requireDMAccess } from "@/lib/community/permissions"
import { handleAttachmentUpload, runAttachmentUpload } from "@/lib/community/upload"
import { communityMediaCleanupErrorCategory } from "@/lib/community/community-media-cleanup"

const log = createLogger({ service: "community-attachments-upload" })

// A bot addresses by ref-in-query (`?target=`, the folded `attachmentUpload`
// verb); the path `[id]` is then the `resolve` placeholder (a ref carries `/`),
// which the bot arm ignores — it resolves the ref itself. A human/web caller
// puts the real channelId in the path. Mirrors the channels/[id]/members
// dual-actor door.
/**
 * POST /api/community/channels/[id]/attachments — the canonical
 * attachment-upload door. Dual-actor (route/disc trunk — folds the bot
 * `attachmentUpload` verb + re-homes the human `channels/[id]/upload` route):
 *   - human/web (id-in-path) → `runAttachmentUpload`: multipart file →
 *     surface-derived kind → R2 put; returns the pre-refactor carrier shape
 *     `{ url, filename, contentType, size }` (the `/media/<key>` URL the
 *     composer echoes back on send). The composer switches to reserve-by-id in
 *     step (b); until then the human upload→send round-trip stays key-carried.
 *   - bot/CLI (ref-in-query) → resolve `?target=<ref>` member-scoped, gate
 *     write access identical to `send`, upload, then reserve a PENDING row
 *     (messageId = NULL) and return `{ id, filename, contentType, size }` —
 *     the bot holds the id and passes it to `send` later.
 *
 * Response FORM forks by the credential actor (never a field). The bot arm is
 * byte-identical to the old flat `attachmentUpload` route; the human arm
 * delegates to the same shared trunk the old `channels/[id]/upload` route did.
 */
export const POST = withCommunityActor(async (req: NextRequest, ctx) => {
  if (ctx.actor.kind === "bot") {
    return handleBotAttachmentUpload(req, ctx)
  }
  // Human arm — id-in-path, shared upload trunk (surface dispatch +
  // per-surface guard + DM block gate live inside runAttachmentUpload).
  return runAttachmentUpload(req, {
    env: ctx.env,
    userId: ctx.actor.userId,
    email: ctx.actor.email,
    workspaceId: ctx.actor.workspaceId,
    params: ctx.params,
  })
})

/**
 * Bot upload arm. Body unchanged from the old flat `attachmentUpload` route
 * except that the ref arrives via `?target=` while the path carries the
 * `resolve` placeholder (the door is now id-in-path for humans). Best-effort R2
 * cleanup on a D1-throw so no orphan blob is left when the pending-row insert
 * fails.
 */
async function handleBotAttachmentUpload(
  req: NextRequest,
  ctx: { env: Env; actor: CommunityActor },
): Promise<NextResponse | Response> {
  // requireBot backstop — the dispatch already routed only bots here, but the
  // guard keeps the bot-only authz on the arm itself (not on "no one else
  // calls it"), matching the dual-actor discipline the other folded verbs use.
  const gate0 = requireBot(ctx.actor)
  if (!gate0.ok) return gate0.response
  const botUserId = gate0.bot.userId

  // Track any R2 blob written before the D1 insert throws so the catch below
  // can best-effort delete it. Hoisted here so the try/catch can see it.
  let r2KeysToCleanUp: string[] = []

  try {
    const target = req.nextUrl.searchParams.get("target")
    if (!target) {
      return NextResponse.json({ error: "missing target query param" }, { status: 400 })
    }

    const db = getDb(ctx.env.DB)

    const resolved = await resolveTargetForMember(db, botUserId, target)
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
    r2KeysToCleanUp = [result.r2Key, ...(result.thumbnailR2Key ? [result.thumbnailR2Key] : [])]

    const row = await queries.communityAttachment.createPendingAttachment(db, {
      uploaderId: botUserId,
      targetId,
      r2Key: result.r2Key,
      thumbnailR2Key: result.thumbnailR2Key,
      filename: result.filename,
      contentType: result.contentType,
      size: result.size,
      width: result.width,
      height: result.height,
    })

    return NextResponse.json({
      id: row.id,
      filename: row.filename,
      contentType: result.contentType || "application/octet-stream",
      size: result.size,
      hasThumbnail: result.thumbnailR2Key !== null,
    })
  } catch (err) {
    let r2KeyCleaned = false
    if (r2KeysToCleanUp.length > 0) {
      try {
        await ctx.env.COMMUNITY_MEDIA.delete(
          r2KeysToCleanUp.length === 1 ? r2KeysToCleanUp[0]! : r2KeysToCleanUp,
        )
        r2KeyCleaned = true
      } catch (cleanupErr) {
        log.error("attachment_route_r2_cleanup_failed", {
          route: "channels/[id]/attachments",
          actor: "bot",
          objectCount: r2KeysToCleanUp.length,
          errorCategory: communityMediaCleanupErrorCategory(cleanupErr),
        })
      }
    }
    log.error("attachment_route_failure", {
      route: "channels/[id]/attachments",
      botUserId,
      r2KeyCleaned,
      cause: err instanceof Error ? err.stack ?? err.message : String(err),
    })
    return NextResponse.json({ error: "internal error", code: "internal" }, { status: 500 })
  }
}
