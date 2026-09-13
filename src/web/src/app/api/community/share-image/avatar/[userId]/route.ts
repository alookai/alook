import { NextRequest } from "next/server"
import { queries } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { writeError } from "@/lib/middleware/helpers"

const ALLOWED_AVATAR_HOSTS = new Set([
  "avatars.githubusercontent.com",
  "lh3.googleusercontent.com",
])
const ALLOWED_IMAGE_TYPES = new Set([
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
])
const MAX_AVATAR_BYTES = 5 * 1024 * 1024
const AVATAR_FETCH_TIMEOUT_MS = 5_000

export function allowedExternalAvatarUrl(value: string): URL | null {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || (url.port && url.port !== "443")
    || !ALLOWED_AVATAR_HOSTS.has(url.hostname.toLowerCase())
  ) return null
  return url
}

async function readLimitedImage(response: Response): Promise<{ bytes: Uint8Array; type: string }> {
  if (!response.ok || response.status >= 300) throw new Error("avatar request failed")
  const type = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? ""
  if (!ALLOWED_IMAGE_TYPES.has(type)) throw new Error("avatar response is not a supported image")
  const contentLength = Number(response.headers.get("content-length") ?? "0")
  if (Number.isFinite(contentLength) && contentLength > MAX_AVATAR_BYTES) {
    throw new Error("avatar response is too large")
  }
  if (!response.body) throw new Error("avatar response body is missing")

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const result = await reader.read()
      if (result.done) break
      size += result.value.byteLength
      if (size > MAX_AVATAR_BYTES) {
        await reader.cancel()
        throw new Error("avatar response is too large")
      }
      chunks.push(result.value)
    }
  } finally {
    reader.releaseLock()
  }

  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { bytes, type }
}

export const GET = withAuth(async (_req: NextRequest, ctx) => {
  const userId = ctx.params?.userId
  if (!userId) return writeError("missing user id", 400)

  const profile = await queries.communityUserProfile.getPublicProfileForViewer(
    getDb(ctx.env.DB),
    userId,
    ctx.userId,
  )
  const source = profile?.image ? allowedExternalAvatarUrl(profile.image) : null
  if (!source) return writeError("external avatar not found", 404)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), AVATAR_FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(source, {
      redirect: "manual",
      signal: controller.signal,
      headers: { Accept: [...ALLOWED_IMAGE_TYPES].join(", ") },
    })
    if (response.status >= 300 && response.status < 400) {
      return writeError("external avatar redirect rejected", 502)
    }
    const image = await readLimitedImage(response)
    const body = new ArrayBuffer(image.bytes.byteLength)
    new Uint8Array(body).set(image.bytes)
    return new Response(body, {
      headers: {
        "Content-Type": image.type,
        "Content-Length": String(image.bytes.byteLength),
        "Cache-Control": "private, max-age=300",
        "X-Content-Type-Options": "nosniff",
      },
    })
  } catch {
    return writeError(
      controller.signal.aborted ? "external avatar timed out" : "external avatar unavailable",
      controller.signal.aborted ? 504 : 502,
    )
  } finally {
    clearTimeout(timer)
  }
})
