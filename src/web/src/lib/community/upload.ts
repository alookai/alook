import { NextRequest, NextResponse } from "next/server"
import {
  MAX_ATTACHMENT_SIZE_BYTES,
  MAX_SERVER_ICON_SIZE_BYTES,
  ALLOWED_ICON_MIME_TYPES,
  queries,
  createLogger,
} from "@alook/shared"
import { requireMessageBearingSurface, requireChildSurface } from "./channel-write-guard"
import { isThread } from "@alook/shared"
import { requireMessageSurfaceAccess } from "./permissions"
import { writeError, writeJSON } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import type { AuthContext } from "@/lib/middleware/auth"
import {
  buildMediaKey,
  buildServerIconKey,
  buildUserAvatarKey,
  buildBotAvatarKey,
  serverIconUrl,
  userAvatarUrl,
  botAvatarUrl,
} from "./storage"

const log = createLogger({ service: "community-attachment-upload" })

type UploadOk = {
  ok: true
  id: string
  key: string
  url: string
  filename: string
  contentType: string
  size: number
}

type UploadErr = { ok: false; response: NextResponse }

export type UploadResult = UploadOk | UploadErr

/**
 * Slim result for the shared attachment-upload primitive. `runAttachmentUpload`
 * and the new agent-upload route both build wire responses from this — the
 * legacy `UploadResult` shape is preserved by callers that wrap it.
 */
type AttachmentUploadOk = {
  ok: true
  r2Key: string
  filename: string
  contentType: string
  size: number
  // Client-computed image dimensions carried on the upload body (thumbnail at
  // file-pick). undefined for non-images and bot uploads. Written onto the
  // pending row at upload — the single source of an attachment's dimensions.
  width?: number
  height?: number
}
export type AttachmentUploadResult = AttachmentUploadOk | UploadErr

type AttachmentKind = "channel" | "dm" | "thread"

/**
 * Provenance tag stamped as R2 `customMetadata`. Human uploads set
 * `uploader: "user"`; agent uploads set `uploader: "bot"` so a future orphan-
 * GC cron can filter cheaply on bot-authored blobs.
 */
export type UploaderTag = {
  uploader: "user" | "bot"
  uploaderUserId: string
}

function mimeAllowed(contentType: string, allowed: readonly string[]): boolean {
  if (!contentType) return false
  return allowed.some((entry) =>
    entry.endsWith("/") ? contentType.startsWith(entry) : contentType === entry,
  )
}

/**
 * Parsed upload form: the `file` plus optional client-computed image
 * dimensions. `width`/`height` are computed browser-side (thumbnail) at
 * file-pick time and ride the SAME multipart body as the file — a `FormData`
 * body can only be read once, so they're extracted here alongside the file.
 * Absent/non-numeric → undefined (a bot upload never sends them; a non-image
 * has none). This is the SINGLE source of an attachment's dimensions: they are
 * written onto the pending row at upload time and never re-supplied on send.
 */
type ParsedUpload = { file: File; width?: number; height?: number }

function parseDimension(raw: FormDataEntryValue | null): number | undefined {
  if (typeof raw !== "string") return undefined
  const n = Number(raw)
  return Number.isInteger(n) && n >= 0 ? n : undefined
}

async function readFile(req: NextRequest): Promise<ParsedUpload | UploadErr> {
  let formData: FormData
  try {
    formData = await req.formData()
  } catch {
    return { ok: false, response: writeError("invalid form data", 400) }
  }
  const file = formData.get("file") as File | null
  if (!file) return { ok: false, response: writeError("no file provided", 400) }
  return {
    file,
    width: parseDimension(formData.get("width")),
    height: parseDimension(formData.get("height")),
  }
}

/**
 * Validate + upload an attachment for a channel / DM / thread.
 *
 * Enforces `MAX_ATTACHMENT_SIZE_BYTES` and `ALLOWED_ATTACHMENT_MIME_PREFIXES`.
 * Returns the stored R2 key + parsed metadata (filename, content-type, size,
 * and any client-supplied image dimensions). The caller persists a pending
 * attachment row keyed by that r2Key; reads then serve it through the canonical
 * `channels/{id}/attachments/{attachmentId}` door (there is no `/media/` route).
 *
 * R2 requires stream bodies to have a known length. Passing the `File` itself
 * preserves that length for the Workers runtime while avoiding an explicit
 * `arrayBuffer()` copy in application code. Size and content-type are
 * read from the `File` object before the put.
 */
export async function handleAttachmentUpload(
  req: NextRequest,
  env: Env,
  kind: AttachmentKind,
  targetId: string,
  uploaderTag: UploaderTag,
): Promise<AttachmentUploadResult> {
  const parsed = await readFile(req)
  if ("ok" in parsed && parsed.ok === false) return parsed
  const { file, width, height } = parsed as ParsedUpload

  if (file.size > MAX_ATTACHMENT_SIZE_BYTES) {
    return {
      ok: false,
      response: writeError(
        `file too large (max ${Math.floor(MAX_ATTACHMENT_SIZE_BYTES / 1024 / 1024)}MB)`,
        413,
      ),
    }
  }
  const contentType = file.type || "application/octet-stream"

  const fileId = crypto.randomUUID()
  const key = buildMediaKey(kind, targetId, fileId, file.name)

  await env.COMMUNITY_MEDIA.put(key, file, {
    httpMetadata: { contentType },
    customMetadata: {
      uploader: uploaderTag.uploader,
      bot_user_id: uploaderTag.uploader === "bot" ? uploaderTag.uploaderUserId : "",
    },
  })

  return {
    ok: true,
    r2Key: key,
    filename: file.name,
    contentType,
    size: file.size,
    width,
    height,
  }
}

/**
 * Validate + upload a server icon. Smaller cap, image-only. Same known-length
 * R2 body rule as `handleAttachmentUpload`.
 */
export async function handleServerIconUpload(
  req: NextRequest,
  env: Env,
  serverId: string,
): Promise<UploadResult> {
  const parsed = await readFile(req)
  if ("ok" in parsed && parsed.ok === false) return parsed
  const { file } = parsed as ParsedUpload

  if (file.size > MAX_SERVER_ICON_SIZE_BYTES) {
    return {
      ok: false,
      response: writeError(
        `icon too large (max ${Math.floor(MAX_SERVER_ICON_SIZE_BYTES / 1024 / 1024)}MB)`,
        413,
      ),
    }
  }
  if (!mimeAllowed(file.type, ALLOWED_ICON_MIME_TYPES as readonly string[])) {
    return { ok: false, response: writeError("icon must be png / jpeg / webp / gif", 400) }
  }

  const fileId = crypto.randomUUID()
  const key = buildServerIconKey(serverId, fileId)

  await env.COMMUNITY_MEDIA.put(key, file, {
    httpMetadata: { contentType: file.type },
  })

  return {
    ok: true,
    id: fileId,
    key,
    // Canonical icon serve route (the media/[...key] catch-all is deleted in the
    // route/disc media-delete step). The icon POST route reads `.key` and builds
    // its own `serverIconUrl` for the response, so this `url` isn't consumed
    // today — but keep it pointed at the real route so no future caller picks up
    // a dead `/media/` path.
    url: serverIconUrl({ id: serverId, icon: key }) ?? "",
    filename: file.name,
    contentType: file.type,
    size: file.size,
  }
}

/**
 * Validate + upload a user/bot avatar to a deterministic key — unlike server
 * icons, there's no `fileId`/old-key-delete dance since R2 `.put()` overwrites
 * the same object in place on every re-upload. Shared by
 * `handleUserAvatarUpload` and `handleBotAvatarUpload`, which only differ in
 * key/URL builder.
 */
async function handleAvatarUpload(
  req: NextRequest,
  env: Env,
  ownerId: string,
  key: string,
  url: string,
): Promise<UploadResult> {
  const parsed = await readFile(req)
  if ("ok" in parsed && parsed.ok === false) return parsed
  const { file } = parsed as ParsedUpload

  if (file.size > MAX_SERVER_ICON_SIZE_BYTES) {
    return {
      ok: false,
      response: writeError(
        `avatar too large (max ${Math.floor(MAX_SERVER_ICON_SIZE_BYTES / 1024 / 1024)}MB)`,
        413,
      ),
    }
  }
  if (!mimeAllowed(file.type, ALLOWED_ICON_MIME_TYPES as readonly string[])) {
    return { ok: false, response: writeError("avatar must be png / jpeg / webp / gif", 400) }
  }

  await env.COMMUNITY_MEDIA.put(key, file, {
    httpMetadata: { contentType: file.type },
  })

  return {
    ok: true,
    id: ownerId,
    key,
    // Avatar uploads return their dedicated routable URL.
    url,
    filename: file.name,
    contentType: file.type,
    size: file.size,
  }
}

export function handleUserAvatarUpload(
  req: NextRequest,
  env: Env,
  userId: string,
): Promise<UploadResult> {
  return handleAvatarUpload(req, env, userId, buildUserAvatarKey(userId), userAvatarUrl(userId))
}

export function handleBotAvatarUpload(
  req: NextRequest,
  env: Env,
  botId: string,
): Promise<UploadResult> {
  return handleAvatarUpload(req, env, botId, buildBotAvatarKey(botId), botAvatarUrl(botId))
}

/**
 * Shared body for the unified attachment-upload trunk. One `id`, dispatched by
 * the channel's surface — the three old per-type routes
 * (`channels/[id]/upload`, `dm/[id]/upload`, `threads/[id]/upload`) have
 * collapsed onto this one; the DM/thread routes are now deleted and the web
 * client uploads through `channels/[id]/upload` for every surface.
 *
 * Access + surface come from `requireMessageSurfaceAccess` (the same dispatch
 * the read/read-state routes use), so a DM id runs `requireDMAccess` (block
 * gate) — closing the incidental P0 the trunk covers.
 *
 * `kind` (which feeds `buildMediaKey` → the R2 key path, so its VALUE is
 * load-bearing, not just its guard) is DERIVED from `(surface, channel.type)`
 * consumed from the dispatch's return — NOT re-queried via a second
 * `getChannelType` (that would be a mini re-derive + extra hop; the dispatch
 * already fetched the row). `surface` alone is lossy (thread and text both
 * present as `surface="channel"`), so the channel arm splits on `channel.type`:
 *   - dm                                  → kind "dm"      (a DM is a legitimate
 *                                            attachment target — no bearing guard)
 *   - channel + thread                    → kind "thread"  (requireChildSurface)
 *   - channel + text/forum(-top)          → kind "channel" (requireMessageBearingSurface)
 * These map byte-for-byte to what the three routes passed before, so new
 * uploads land under the same R2 key prefix (existing attachments read from the
 * stored `r2_key` column and are unaffected — the derivation is write-only).
 */
export async function runAttachmentUpload(
  req: NextRequest,
  ctx: AuthContext & { params?: Record<string, string> },
): Promise<NextResponse> {
  const id = ctx.params?.id
  if (!id) return writeError("missing channel id", 400)

  const db = getDb(ctx.env.DB)
  const auth = await requireMessageSurfaceAccess(db, id, ctx.userId)
  if (!auth.ok) return writeError(auth.error, auth.status)

  // Derive kind + apply the per-surface guard from the dispatch's return — no
  // re-query. The DM arm needs no surface guard (a DM is a valid target).
  let kind: AttachmentKind
  if (auth.value.surface === "dm") {
    kind = "dm"
  } else {
    const channelType = auth.value.channel.type
    if (isThread(channelType)) {
      const child = requireChildSurface(channelType)
      if (!child.ok) return writeError(child.error, child.status)
      kind = "thread"
    } else {
      const surface = requireMessageBearingSurface(channelType)
      if (!surface.ok) return writeError(surface.error, surface.status)
      kind = "channel"
    }
  }

  // Track any R2 blob written before the D1 insert throws so the catch can
  // best-effort delete it (mirrors the bot upload route's orphan-cleanup).
  let r2KeyToCleanUp: string | null = null
  try {
    const result = await handleAttachmentUpload(req, ctx.env, kind, id, {
      uploader: "user",
      uploaderUserId: ctx.userId,
    })
    if (!result.ok) return result.response
    r2KeyToCleanUp = result.r2Key

    // Reserve-by-id (route/disc step 2b): the human composer now mirrors the
    // bot flow — the upload creates a PENDING row (messageId = NULL) and returns
    // its stable id. The composer holds the id in-memory and passes it to `send`,
    // where `reserveAttachmentsForMessage` links it. `uploaderId` is the
    // credential user (self-scope, never from the body); `send` re-verifies the
    // id against (uploader, target) before reserving, so a stolen id can't be
    // attached to another user's message. Image dimensions are written HERE (the
    // single source — they never ride the send body) so the pending row is a
    // self-contained, complete entity at upload time; `reserve` only links it.
    const row = await queries.communityAttachment.createPendingAttachment(db, {
      uploaderId: ctx.userId,
      targetId: id,
      r2Key: result.r2Key,
      filename: result.filename,
      contentType: result.contentType,
      size: result.size,
      width: result.width,
      height: result.height,
    })

    return writeJSON({
      id: row.id,
      filename: row.filename,
      contentType: result.contentType,
      size: result.size,
      ...(result.width !== undefined ? { width: result.width } : {}),
      ...(result.height !== undefined ? { height: result.height } : {}),
    })
  } catch (err) {
    if (r2KeyToCleanUp !== null) {
      try {
        await ctx.env.COMMUNITY_MEDIA.delete(r2KeyToCleanUp)
      } catch (cleanupErr) {
        log.error("attachment_upload_r2_cleanup_failed", {
          route: "channels/[id]/attachments",
          userId: ctx.userId,
          r2Key: r2KeyToCleanUp,
          cleanupErr: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
        })
      }
    }
    log.error("attachment_upload_failure", {
      route: "channels/[id]/attachments",
      userId: ctx.userId,
      cause: err instanceof Error ? err.stack ?? err.message : String(err),
    })
    return writeError("internal error", 500)
  }
}
