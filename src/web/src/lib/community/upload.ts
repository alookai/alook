import { readUploadFormData, UploadTooLargeError } from "./upload-body"
import { createHash } from "node:crypto"
import { NextRequest, NextResponse } from "next/server"
import {
  MAX_ATTACHMENT_SIZE_BYTES,
  MAX_INLINE_IMAGE_SIZE_BYTES,
  MAX_SERVER_ICON_SIZE_BYTES,
  ALLOWED_ICON_MIME_TYPES,
  queries,
  createLogger,
} from "@alook/shared"
import { requireMessageBearingSurface, requireChildSurface } from "./channel-write-guard"
import { isThread } from "@alook/shared"
import { requireMessageSurfaceCommunicationAccess } from "./permissions"
import { writeError, writeJSON } from "@/lib/middleware/helpers"
import { getPrimaryDb } from "@/lib/db"
import type { AuthContext } from "@/lib/middleware/auth"
import { isInlineAttachmentContentType } from "./attachment-content-type"
import {
  buildServerIconKey,
  buildUserAvatarObjectKey,
  buildBotAvatarObjectKey,
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

type AttachmentUploadOk = {
  ok: true
  r2Key: string
  hasThumbnail: boolean
  filename: string
  contentType: string
  size: number
  width?: number
  height?: number
}
export type AttachmentUploadResult = AttachmentUploadOk | UploadErr

function mimeAllowed(contentType: string, allowed: readonly string[]): boolean {
  if (!contentType) return false
  return allowed.some((entry) =>
    entry.endsWith("/") ? contentType.startsWith(entry) : contentType === entry,
  )
}

type ParsedUpload = {
  file: File
  width?: number
  height?: number
}

function isFileLike(value: FormDataEntryValue | null): value is File {
  return value !== null && typeof value !== "string" &&
    typeof value.name === "string" && typeof value.type === "string" &&
    typeof value.size === "number" && typeof value.arrayBuffer === "function"
}

function parseDimension(raw: FormDataEntryValue | null): number | undefined {
  if (typeof raw !== "string") return undefined
  const n = Number(raw)
  return Number.isInteger(n) && n >= 0 ? n : undefined
}

async function readFile(req: NextRequest): Promise<ParsedUpload | UploadErr> {
  let formData: FormData
  try {
    formData = await readUploadFormData(req)
  } catch (error) {
    return { ok: false, response: writeError("invalid or oversized upload request", error instanceof UploadTooLargeError ? 413 : 400) }
  }
  if (formData.has("thumbnail")) return { ok: false, response: writeError("thumbnail uploads are no longer supported; update your client", 400) }
  const fields = new Set<string>()
  for (const key of formData.keys()) {
    if (!["file", "width", "height"].includes(key) || fields.has(key)) {
      return { ok: false, response: writeError("unexpected or repeated upload field", 400) }
    }
    fields.add(key)
  }
  const file = formData.get("file")
  if (!isFileLike(file)) return { ok: false, response: writeError("no file provided", 400) }
  return {
    file,
    width: parseDimension(formData.get("width")),
    height: parseDimension(formData.get("height")),
  }
}

async function putAttachmentContent(bucket: R2Bucket, file: File, prefix: string): Promise<string> {
  const hash = createHash("sha256")
  const reader = file.stream().getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      hash.update(value)
    }
  } finally {
    reader.releaseLock()
  }
  const digest = hash.digest("hex")
  const key = `${prefix}/sha256/${digest}`
  const stored = await bucket.put(key, file, {
    onlyIf: { etagDoesNotMatch: "*" },
    sha256: digest,
  }) ?? await bucket.head(key)
  if (!stored || stored.size !== file.size || !stored.checksums.sha256
    || Buffer.from(stored.checksums.sha256).toString("hex") !== digest) {
    throw new Error("attachment content verification failed")
  }
  return key
}

export async function handleAttachmentUpload(
  req: NextRequest,
  env: Env,
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
  if (isInlineAttachmentContentType(contentType) && file.size > MAX_INLINE_IMAGE_SIZE_BYTES) {
    return { ok: false, response: writeError("image too large (max 20 MB)", 413) }
  }

  const key = await putAttachmentContent(env.COMMUNITY_MEDIA, file, "attachments")

  return {
    ok: true,
    r2Key: key,
    hasThumbnail: isInlineAttachmentContentType(contentType),
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

/** Validate and upload one immutable user/bot avatar object. */
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
  return handleAvatarUpload(
    req,
    env,
    userId,
    buildUserAvatarObjectKey(userId, crypto.randomUUID()),
    userAvatarUrl(userId),
  )
}

export function handleBotAvatarUpload(
  req: NextRequest,
  env: Env,
  botId: string,
): Promise<UploadResult> {
  return handleAvatarUpload(
    req,
    env,
    botId,
    buildBotAvatarObjectKey(botId, crypto.randomUUID()),
    botAvatarUrl(botId),
  )
}

export async function runAttachmentUpload(
  req: NextRequest,
  ctx: AuthContext & { params?: Record<string, string> },
): Promise<NextResponse> {
  const id = ctx.params?.id
  if (!id) return writeError("missing channel id", 400)

  // This authorization is read-before-write. Use the primary so an immediately
  // preceding unfriend/block cannot be hidden by replica lag.
  const db = getPrimaryDb(ctx.env.DB)
  const auth = await requireMessageSurfaceCommunicationAccess(db, id, ctx.userId)
  if (!auth.ok) return writeError(auth.error, auth.status)

  if (auth.value.surface !== "dm") {
    const channelType = auth.value.channel.type
    const surface = isThread(channelType)
      ? requireChildSurface(channelType)
      : requireMessageBearingSurface(channelType)
    if (!surface.ok) return writeError(surface.error, surface.status)
  }

  try {
    const result = await handleAttachmentUpload(req, ctx.env)
    if (!result.ok) return result.response
    const row = await queries.communityAttachment.createAttachment(db, {
      uploaderId: ctx.userId,
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
      hasThumbnail: result.hasThumbnail,
      ...(result.width !== undefined ? { width: result.width } : {}),
      ...(result.height !== undefined ? { height: result.height } : {}),
    })
  } catch (err) {
    log.error("attachment_upload_failure", {
      route: "channels/[id]/attachments",
      userId: ctx.userId,
      cause: err instanceof Error ? err.stack ?? err.message : String(err),
    })
    return writeError("internal error", 500)
  }
}
