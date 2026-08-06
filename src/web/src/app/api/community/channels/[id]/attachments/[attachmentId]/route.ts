import { NextResponse, type NextRequest } from "next/server"
import { queries, createLogger, CACHE_IMMUTABLE } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withCommunityActor, type CommunityActor } from "@/lib/middleware/community-actor"
import { requireChannelMember, requireDMAccess } from "@/lib/community/permissions"

const log = createLogger({ service: "community-attachments-download" })

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
 * GET /api/community/channels/[id]/attachments/[attachmentId] — the canonical
 * attachment-download door. Dual-actor (route/disc trunk — folds the bot
 * `attachmentDownload` verb + the human `media/[...key]` GET's attachment
 * part):
 *   - human/web (`<img src>` / link) → cookie session → bytes + inline/attach
 *     `Content-Disposition` + immutable cache (the media route's serve shape).
 *   - bot/CLI (crk_ bearer) → raw body + `X-Alook-Filename` (RFC 5987), the
 *     shape the daemon `callDownload` buffers and writes to disk.
 *
 * ⚠ CONFUSED-DEPUTY (top red line, Aigneis ② / Blondie): authorization is
 * derived from the ATTACHMENT ROW's OWN channel (attachmentId → row →
 * row.messageId → message.channelId → membership), NEVER from the path `[id]`.
 * The `[id]` segment is a routing anchor only; a member of channel A must not
 * reach an attachment of channel B by putting A's id in the path. The old flat
 * `attachmentDownload` did this correctly — the fold does not regress it.
 *
 * Enumeration-safe: every "you can't have this" path (pending non-owner,
 * not-a-member, genuine miss) returns the SAME 404. A distinct 502 fires only
 * when the DB row exists but R2 has drifted (infra fault, not a user-facing
 * gate). Response FORM forks by actor; the authz core is identical.
 */
export const GET = withCommunityActor(async (req: NextRequest, ctx) => {
  const attachmentId = ctx.params?.attachmentId
  if (!attachmentId) {
    return NextResponse.json({ error: "attachment not found" }, { status: 404 })
  }

  const userId = ctx.actor.userId
  try {
    const db = getDb(ctx.env.DB)

    // Authorize from the ROW's own channel — never trust the path `[id]`.
    const authz = await authorizeAttachment(ctx.actor, db, attachmentId)
    if (!authz.ok) {
      // Enumeration-safe: every deny is an indistinguishable 404.
      return NextResponse.json({ error: "attachment not found" }, { status: 404 })
    }
    const row = authz.row

    const obj = await ctx.env.COMMUNITY_MEDIA.get(row.r2Key)
    if (!obj) {
      // Row exists but R2 has no object — infra fault, distinct from the
      // enumeration-safe 404 above.
      return NextResponse.json({ error: "attachment storage unavailable" }, { status: 502 })
    }

    const contentType =
      row.contentType || obj.httpMetadata?.contentType || "application/octet-stream"

    if (ctx.actor.kind === "bot") {
      // Bot arm — raw body + X-Alook-Filename. Buffer inside the try/catch so an
      // R2 stream mid-read error surfaces as a structured 500 rather than a
      // truncated 200 the daemon-side helper can't parse. The daemon
      // `callDownload` buffers via arrayBuffer (attachments cap at 25 MB), so
      // no streaming behavior is lost.
      const size = row.size ?? obj.size
      const headers: Record<string, string> = {
        "Content-Type": contentType,
        "X-Alook-Filename": encodeRfc5987(row.filename),
      }
      if (typeof size === "number") headers["Content-Length"] = String(size)
      const buffer = await obj.arrayBuffer()
      return new Response(buffer, { headers })
    }

    // Human arm — inline for images, attachment download otherwise, immutable
    // cache (the media route's serve shape). Stream the body directly.
    const isImage = contentType.startsWith("image/")
    return new Response(obj.body, {
      headers: {
        "Content-Type": contentType,
        "Content-Disposition": isImage
          ? "inline"
          : `attachment; filename="${row.filename}"`,
        "Cache-Control": CACHE_IMMUTABLE,
      },
    })
  } catch (err) {
    log.error("attachment_route_failure", {
      route: "channels/[id]/attachments/[attachmentId]",
      actorKind: ctx.actor.kind,
      userId,
      cause: err instanceof Error ? err.stack ?? err.message : String(err),
    })
    return NextResponse.json({ error: "internal error", code: "internal" }, { status: 500 })
  }
})

type AuthzOk = {
  ok: true
  row: NonNullable<Awaited<ReturnType<typeof queries.communityAttachment.getAttachmentById>>>
}

/**
 * Confused-deputy-safe attachment authorization. Returns the row ONLY when the
 * caller may read it, deriving scope from the row's own channel — the path
 * `[id]` is never consulted. Both actor arms run the identical gate:
 *   - pending row (messageId = NULL) → only the uploading actor (round-trip).
 *   - persisted row → resolve the row's message → its channel → membership /
 *     DM access.
 * Any deny collapses to `{ ok: false }` so the caller can render a uniform 404.
 */
async function authorizeAttachment(
  actor: CommunityActor,
  db: ReturnType<typeof getDb>,
  attachmentId: string,
): Promise<AuthzOk | { ok: false }> {
  const userId = actor.userId
  const row = await queries.communityAttachment.getAttachmentById(db, attachmentId)
  if (!row) return { ok: false }

  if (row.messageId === null) {
    // Pending row — only the uploading actor may see it (round-trip verify).
    if (row.uploaderId !== userId) return { ok: false }
    return { ok: true, row }
  }

  // Persisted row — resolve target scope FROM THE ROW, then run the standard
  // membership gate. Any non-ok collapses to a generic deny so a prober can't
  // tell "not a member" from "row doesn't exist".
  const message = await queries.communityMessage.getMessage(db, row.messageId)
  if (!message) return { ok: false }
  const channelType = await queries.communityChannel.getChannelType(db, message.channelId)
  if (channelType === "dm") {
    const gate = await requireDMAccess(db, message.channelId, userId)
    if (!gate.ok) return { ok: false }
  } else {
    const gate = await requireChannelMember(db, message.channelId, userId)
    if (!gate.ok) return { ok: false }
  }
  return { ok: true, row }
}
