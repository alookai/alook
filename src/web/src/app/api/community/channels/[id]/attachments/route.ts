import { NextResponse, type NextRequest } from "next/server"
import { queries, createLogger } from "@alook/shared"
import { getPrimaryDb } from "@/lib/db"
import { withCommunityActor, requireBot, type CommunityActor } from "@/lib/middleware/community-actor"
import { resolveTargetForMember, resolveErrorResponse } from "@/lib/community/resolve-ref"
import {
  requireChannelMember,
  requireDMCommunicationAccess,
} from "@/lib/community/permissions"
import { handleAttachmentUpload, runAttachmentUpload } from "@/lib/community/upload"

const log = createLogger({ service: "community-attachments-upload" })

// A bot addresses by ref-in-query (`?target=`, the folded `attachmentUpload`
// verb); the path `[id]` is then the `resolve` placeholder (a ref carries `/`),
// which the bot arm ignores — it resolves the ref itself. A human/web caller
// puts the real channelId in the path. Mirrors the channels/[id]/members
// dual-actor door.
export const POST = withCommunityActor(async (req: NextRequest, ctx) => {
  if (ctx.actor.kind === "bot") {
    return handleBotAttachmentUpload(req, ctx)
  }
  // Human arm — id-in-path, shared upload trunk (surface dispatch +
  // per-surface guard + DM accepted-friend communication gate live inside
  // runAttachmentUpload).
  return runAttachmentUpload(req, {
    env: ctx.env,
    userId: ctx.actor.userId,
    email: ctx.actor.email,
    workspaceId: ctx.actor.workspaceId,
    params: ctx.params,
  })
})

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

  try {
    const db = getPrimaryDb(ctx.env.DB)
    const target = req.nextUrl.searchParams.get("target")
    if (target !== null) {
      if (!target) return NextResponse.json({ error: "missing target query param" }, { status: 400 })
      // Legacy callers retain their existing primary target authorization.
      const resolved = await resolveTargetForMember(db, botUserId, target)
      if ("error" in resolved) return resolveErrorResponse(resolved)
      if (resolved.kind === "dm") {
        const gate = await requireDMCommunicationAccess(db, resolved.channelId, botUserId)
        if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })
      } else {
        const gate = await requireChannelMember(db, resolved.channelId, botUserId)
        if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })
      }
    }

    const result = await handleAttachmentUpload(req, ctx.env)
    if (!result.ok) return result.response

    const row = await queries.communityAttachment.createAttachment(db, {
      uploaderId: botUserId,
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
    log.error("attachment_route_failure", {
      route: "channels/[id]/attachments",
      botUserId,
      cause: err instanceof Error ? err.stack ?? err.message : String(err),
    })
    return NextResponse.json({ error: "internal error", code: "internal" }, { status: 500 })
  }
}
