import { NextRequest, NextResponse } from "next/server"
import {
  MAX_ATTACHMENT_SIZE_BYTES,
  MAX_SERVER_ICON_SIZE_BYTES,
  ALLOWED_ATTACHMENT_MIME_PREFIXES,
  ALLOWED_ICON_MIME_TYPES,
} from "@alook/shared"
import { writeError } from "@/lib/middleware/helpers"
import { buildMediaKey, buildServerIconKey } from "./storage"

export type UploadOk = {
  ok: true
  id: string
  key: string
  url: string
  filename: string
  contentType: string
  size: number
}

export type UploadErr = { ok: false; response: NextResponse }

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

  await env.COMMUNITY_MEDIA.put(key, await file.arrayBuffer(), {
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
 * Validate + upload a server icon. Smaller cap, image-only.
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

  await env.COMMUNITY_MEDIA.put(key, await file.arrayBuffer(), {
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
