import { NextResponse, type NextRequest } from "next/server"
import { createLogger } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withCommunityActor } from "@/lib/middleware/community-actor"
import { authorizeAttachment } from "@/lib/community/attachment-authorization"
import { ATTACHMENT_PRIVATE_IMMUTABLE_CACHE } from "@/lib/community/storage"
import { resolveAttachmentPresentation, resolveMediaContentType } from "@/lib/community/attachment-presentation"

const log = createLogger({ service: "community-attachments-download" })

type ParsedByteRange = { offset: number; length: number; end: number }

function parseByteRange(value: string, size: number): ParsedByteRange | null {
  if (!Number.isSafeInteger(size) || size <= 0) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(value)
  if (!match || (!match[1] && !match[2])) return null

  if (!match[1]) {
    const suffix = Number(match[2])
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null
    const length = Math.min(suffix, size)
    const offset = size - length
    return { offset, length, end: size - 1 }
  }

  const offset = Number(match[1])
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= size) return null
  const requestedEnd = match[2] ? Number(match[2]) : size - 1
  if (!Number.isSafeInteger(requestedEnd) || requestedEnd < offset) return null
  const end = Math.min(requestedEnd, size - 1)
  return { offset, length: end - offset + 1, end }
}

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
 *   - human/web (`<img>`, native media, or link) → cookie session → bytes +
 *     inline/attach `Content-Disposition` + immutable cache. Audio/video also
 *     accept one byte range for native playback and seeking.
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

    const storedPresentation = resolveAttachmentPresentation(row.filename, row.contentType)
    const isStoredMedia = storedPresentation.category === "audio" || storedPresentation.category === "video"
    const requestedRange = ctx.actor.kind === "human" && isStoredMedia
      ? req.headers.get("range")
      : null
    let knownSize = row.size
    if (requestedRange && (!Number.isSafeInteger(knownSize) || (knownSize ?? -1) < 0)) {
      const metadata = await ctx.env.COMMUNITY_MEDIA.head(row.r2Key)
      if (!metadata) {
        return NextResponse.json({ error: "attachment storage unavailable" }, { status: 502 })
      }
      knownSize = metadata.size
    }

    const parsedRange = requestedRange && knownSize !== null
      ? parseByteRange(requestedRange, knownSize)
      : null
    if (requestedRange && !parsedRange) {
      return new Response(null, {
        status: 416,
        headers: {
          "Accept-Ranges": "bytes",
          "Content-Range": `bytes */${knownSize ?? 0}`,
        },
      })
    }

    const obj = parsedRange
      ? await ctx.env.COMMUNITY_MEDIA.get(row.r2Key, {
          range: { offset: parsedRange.offset, length: parsedRange.length },
        })
      : await ctx.env.COMMUNITY_MEDIA.get(row.r2Key)
    if (!obj) {
      // Row exists but R2 has no object — infra fault, distinct from the
      // enumeration-safe 404 above.
      return NextResponse.json({ error: "attachment storage unavailable" }, { status: 502 })
    }

    const storedContentType = row.contentType || obj.httpMetadata?.contentType || "application/octet-stream"
    const contentType = resolveMediaContentType(row.filename, storedContentType) ?? storedContentType

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

    const isImage = contentType.startsWith("image/")
    const isMedia = contentType.startsWith("audio/") || contentType.startsWith("video/")
    const size = knownSize ?? row.size ?? obj.size
    const headers: Record<string, string> = {
      "Content-Type": contentType,
      "Content-Disposition": isImage || isMedia
        ? "inline"
        : `attachment; filename="${row.filename}"`,
      "Cache-Control": ATTACHMENT_PRIVATE_IMMUTABLE_CACHE,
      "Content-Length": String(parsedRange?.length ?? size),
    }
    if (isMedia) headers["Accept-Ranges"] = "bytes"
    if (parsedRange) {
      headers["Content-Range"] = `bytes ${parsedRange.offset}-${parsedRange.end}/${size}`
    }
    return new Response(obj.body, {
      status: parsedRange ? 206 : 200,
      headers,
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
