import { createHash } from "node:crypto"
import { NextRequest, NextResponse } from "next/server"
import {
  MAX_ATTACHMENT_SIZE_BYTES,
  MAX_ATTACHMENT_THUMBNAIL_EDGE_PX,
  MAX_ATTACHMENT_THUMBNAIL_SIZE_BYTES,
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
  thumbnailR2Key: string | null
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
  thumbnail?: File
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

const JPEG_SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3,
  0xc5, 0xc6, 0xc7,
  0xc9, 0xca, 0xcb,
  0xcd, 0xce, 0xcf,
])

function jpegDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null
  let offset = 2
  let dimensions: { width: number; height: number } | null = null
  let frameComponentIds: Set<number> | null = null
  let sawScan = false

  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) return null
    while (bytes[offset] === 0xff) offset++
    const marker = bytes[offset++]
    if (marker === undefined || marker === 0x00 || marker === 0xd8) return null
    if (marker === 0xd9) {
      return sawScan && dimensions && offset === bytes.length ? dimensions : null
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) return null
    if (offset + 1 >= bytes.length) return null
    const length = (bytes[offset]! << 8) | bytes[offset + 1]!
    if (length < 2 || offset + length > bytes.length) return null

    if (JPEG_SOF_MARKERS.has(marker)) {
      if (dimensions || length < 11) return null
      const height = (bytes[offset + 3]! << 8) | bytes[offset + 4]!
      const width = (bytes[offset + 5]! << 8) | bytes[offset + 6]!
      const componentCount = bytes[offset + 7]!
      if (
        width === 0 || height === 0 || componentCount === 0 || componentCount > 4
        || length !== 8 + 3 * componentCount
      ) return null

      frameComponentIds = new Set<number>()
      for (let index = 0; index < componentCount; index++) {
        const componentOffset = offset + 8 + index * 3
        const id = bytes[componentOffset]!
        const sampling = bytes[componentOffset + 1]!
        if (frameComponentIds.has(id) || sampling === 0) return null
        frameComponentIds.add(id)
      }
      dimensions = { width, height }
    }

    if (marker === 0xda) {
      if (!dimensions || !frameComponentIds || length < 8) return null
      const scanComponentCount = bytes[offset + 2]!
      if (
        scanComponentCount === 0 || scanComponentCount > frameComponentIds.size
        || length !== 6 + 2 * scanComponentCount
      ) return null

      const scanComponentIds = new Set<number>()
      for (let index = 0; index < scanComponentCount; index++) {
        const id = bytes[offset + 3 + index * 2]!
        if (!frameComponentIds.has(id) || scanComponentIds.has(id)) return null
        scanComponentIds.add(id)
      }

      offset += length
      let sawEntropyData = false
      while (offset < bytes.length) {
        if (bytes[offset] !== 0xff) {
          sawEntropyData = true
          offset++
          continue
        }

        const markerOffset = offset
        while (bytes[offset] === 0xff) offset++
        const scanMarker = bytes[offset]
        if (scanMarker === undefined) return null
        if (scanMarker === 0x00) {
          sawEntropyData = true
          offset++
          continue
        }
        if (scanMarker >= 0xd0 && scanMarker <= 0xd7) {
          offset++
          continue
        }
        if (!sawEntropyData) return null

        sawScan = true
        offset = markerOffset
        break
      }
      if (!sawScan) return null
      continue
    }

    offset += length
  }
  return null
}

async function readFile(req: NextRequest): Promise<ParsedUpload | UploadErr> {
  let formData: FormData
  try {
    formData = await req.formData()
  } catch {
    return { ok: false, response: writeError("invalid form data", 400) }
  }
  const file = formData.get("file")
  if (!isFileLike(file)) return { ok: false, response: writeError("no file provided", 400) }
  const thumbnailEntry = formData.get("thumbnail")
  if (thumbnailEntry !== null && !isFileLike(thumbnailEntry)) {
    return { ok: false, response: writeError("invalid thumbnail", 400) }
  }
  return {
    file,
    ...(isFileLike(thumbnailEntry) ? { thumbnail: thumbnailEntry } : {}),
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
  const { file, thumbnail, width, height } = parsed as ParsedUpload

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
  const thumbnailRequired = isInlineAttachmentContentType(contentType) && (
    file.size > MAX_ATTACHMENT_THUMBNAIL_SIZE_BYTES
    || (width !== undefined && width > MAX_ATTACHMENT_THUMBNAIL_EDGE_PX)
    || (height !== undefined && height > MAX_ATTACHMENT_THUMBNAIL_EDGE_PX)
  )

  if (thumbnailRequired && !thumbnail) {
    return { ok: false, response: writeError("thumbnail required", 400) }
  }

  if (thumbnail) {
    if (!isInlineAttachmentContentType(contentType)) {
      return { ok: false, response: writeError("thumbnail requires a supported raster image", 400) }
    }
    if (thumbnail.type !== "image/jpeg") {
      return { ok: false, response: writeError("thumbnail must be image/jpeg", 400) }
    }
    if (thumbnail.size > MAX_ATTACHMENT_THUMBNAIL_SIZE_BYTES) {
      return { ok: false, response: writeError("thumbnail too large", 400) }
    }
    const signature = new Uint8Array(await thumbnail.arrayBuffer())
    const dimensions = jpegDimensions(signature)
    if (!dimensions) {
      return { ok: false, response: writeError("invalid jpeg thumbnail", 400) }
    }
    if (Math.max(dimensions.width, dimensions.height) > MAX_ATTACHMENT_THUMBNAIL_EDGE_PX) {
      return { ok: false, response: writeError("thumbnail dimensions too large", 400) }
    }
  }

  const key = await putAttachmentContent(env.COMMUNITY_MEDIA, file, "attachments")
  const thumbnailR2Key = thumbnail
    ? await putAttachmentContent(env.COMMUNITY_MEDIA, thumbnail, "attachment-thumbnails")
    : null

  return {
    ok: true,
    r2Key: key,
    thumbnailR2Key,
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
      thumbnailR2Key: result.thumbnailR2Key,
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
      hasThumbnail: result.thumbnailR2Key !== null,
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
