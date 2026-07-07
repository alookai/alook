import { NextRequest, NextResponse } from "next/server"
import {
  MAX_ATTACHMENT_SIZE_BYTES,
  MAX_SERVER_ICON_SIZE_BYTES,
  ALLOWED_ATTACHMENT_MIME_PREFIXES,
  ALLOWED_ICON_MIME_TYPES,
} from "@alook/shared"
import type { Database } from "@alook/shared"
import { writeError, writeJSON } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import type { AuthContext } from "@/lib/middleware/auth"
import type { Result } from "./permissions"
import { buildMediaKey, buildServerIconKey } from "./storage"

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

type AttachmentKind = "channel" | "dm" | "thread"

function mimeAllowed(contentType: string, allowed: readonly string[]): boolean {
  if (!contentType) return false
  return allowed.some((entry) =>
    entry.endsWith("/") ? contentType.startsWith(entry) : contentType === entry,
  )
}

async function readFile(req: NextRequest): Promise<File | UploadErr> {
  let formData: FormData
  try {
    formData = await req.formData()
  } catch {
    return { ok: false, response: writeError("invalid form data", 400) }
  }
  const file = formData.get("file") as File | null
  if (!file) return { ok: false, response: writeError("no file provided", 400) }
  return file
}

/**
 * Validate + upload an attachment for a channel / DM / thread.
 *
 * Enforces `MAX_ATTACHMENT_SIZE_BYTES` and `ALLOWED_ATTACHMENT_MIME_PREFIXES`.
 * Returns the R2 key + a `/api/community/media/<key>` URL that the auth-gated
 * media route can serve.
 *
 * R2 requires stream bodies to have a known length. Passing the `File` itself
 * preserves that length for the Workers runtime while avoiding an explicit
 * `arrayBuffer()` copy in application code. Size and content-type are
 * validated against the `File` object before the put.
 */
export async function handleAttachmentUpload(
  req: NextRequest,
  env: Env,
  kind: AttachmentKind,
  targetId: string,
): Promise<UploadResult> {
  const fileOrErr = await readFile(req)
  if ("ok" in fileOrErr && fileOrErr.ok === false) return fileOrErr
  const file = fileOrErr as File

  if (file.size > MAX_ATTACHMENT_SIZE_BYTES) {
    return {
      ok: false,
      response: writeError(
        `file too large (max ${Math.floor(MAX_ATTACHMENT_SIZE_BYTES / 1024 / 1024)}MB)`,
        413,
      ),
    }
  }
  if (!mimeAllowed(file.type, ALLOWED_ATTACHMENT_MIME_PREFIXES as readonly string[])) {
    return { ok: false, response: writeError("file type not allowed", 400) }
  }

  const fileId = crypto.randomUUID()
  const key = buildMediaKey(kind, targetId, fileId, file.name)

  await env.COMMUNITY_MEDIA.put(key, file, {
    httpMetadata: { contentType: file.type },
  })

  return {
    ok: true,
    id: fileId,
    key,
    url: `/api/community/media/${key}`,
    filename: file.name,
    contentType: file.type,
    size: file.size,
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
  const fileOrErr = await readFile(req)
  if ("ok" in fileOrErr && fileOrErr.ok === false) return fileOrErr
  const file = fileOrErr as File

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
    url: `/api/community/media/${key}`,
    filename: file.name,
    contentType: file.type,
    size: file.size,
  }
}

/**
 * Route body shared by the three attachment-upload endpoints
 * (`channels/[id]/upload`, `dm/[id]/upload`, `threads/[id]/upload`). Parses
 * the `id` param, runs the caller-supplied permission check, then hands off
 * to `handleAttachmentUpload`. Keeping the three route files thin also keeps
 * their URLs distinct — we deliberately did not collapse to a single route.
 */
export async function runAttachmentUpload(
  req: NextRequest,
  ctx: AuthContext & { params?: Record<string, string> },
  kind: AttachmentKind,
  permissionCheck: (db: Database, id: string, userId: string) => Promise<Result<unknown>>,
): Promise<NextResponse> {
  const id = ctx.params?.id
  if (!id) {
    const label =
      kind === "channel" ? "channel id" : kind === "dm" ? "dm id" : "id"
    return writeError(`missing ${label}`, 400)
  }

  const db = getDb(ctx.env.DB)
  const auth = await permissionCheck(db, id, ctx.userId)
  if (!auth.ok) return writeError(auth.error, auth.status)

  const result = await handleAttachmentUpload(req, ctx.env, kind, id)
  if (!result.ok) return result.response

  return writeJSON({
    url: result.url,
    filename: result.filename,
    contentType: result.contentType,
    size: result.size,
  })
}
