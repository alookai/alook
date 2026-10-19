import type { NextRequest } from "next/server"
import { withAuth, type AuthenticatedHandler } from "@/lib/middleware/auth"
import { varyPrivateResponseByCredentials } from "@/lib/middleware/response-cache"
import { writeError } from "@/lib/middleware/helpers"
import { checkRateLimit } from "@/lib/rate-limit"

export class AudioError extends Error {
  constructor(message: string, public readonly status: number) { super(message) }
}

export async function readAudioBytes(source: Request | Response, maxBytes: number): Promise<Uint8Array> {
  const declared = source.headers.get("content-length")
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) throw new AudioError("Audio request exceeds the size limit", 413)
  if (!source.body) throw new AudioError("A request body is required", 400)
  const reader = source.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      length += next.value.byteLength
      if (length > maxBytes) { await reader.cancel().catch(() => undefined); throw new AudioError("Audio request exceeds the size limit", 413) }
      chunks.push(next.value)
    }
  } catch (error) {
    if (error instanceof AudioError) throw error
    throw new AudioError("Could not read the request body", 400)
  } finally { reader.releaseLock() }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return bytes
}

function privateAudioResponse(result: Response): Response {
  const response = new Response(result.body, result)
  response.headers.set("Cache-Control", "private, no-store, max-age=0")
  response.headers.set("X-Content-Type-Options", "nosniff")
  response.headers.delete("ETag")
  response.headers.delete("Last-Modified")
  return varyPrivateResponseByCredentials(response)
}

export function audioPost(policy: "audio:transcriptions" | "audio:speech", handler: AuthenticatedHandler) {
  const authenticate = withAuth(async (request, ctx) => {
    if (ctx.user?.isBot !== false) return writeError("A human session is required", 403)
    const rate = await checkRateLimit(ctx.env, policy, ctx.userId)
    if (!rate.allowed) return writeError("Too many audio requests", 429, { "Retry-After": String(rate.retryAfterSec) })
    if (!ctx.env.AI) return writeError("Audio service is unavailable", 503)
    return handler(request, ctx)
  })
  return async (request: NextRequest) => {
    try { return privateAudioResponse(await authenticate(request)) }
    catch (error) { return privateAudioResponse(error instanceof AudioError ? writeError(error.message, error.status) : writeError("Audio service is unavailable. Try again.", 503)) }
  }
}
