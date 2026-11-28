import { getCloudflareContext } from "@opennextjs/cloudflare"
import { NextResponse } from "next/server"
import { verifyGitHubOidcToken } from "@/lib/github-oidc"
import {
  RELEASE_MANIFEST_KV_KEY,
  RELEASE_MANIFEST_MAX_BYTES,
  validateReleaseManifest,
} from "@/lib/release-manifest"

const NO_STORE_HEADERS = { "Cache-Control": "no-store" }

function jsonError(error: string, status: number) {
  return NextResponse.json({ error }, { status, headers: NO_STORE_HEADERS })
}

function extractBearerToken(request: Request): string | null {
  const header = request.headers.get("authorization")
  if (!header) return null
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim())
  return match ? match[1] : null
}

async function readBoundedBodyText(
  request: Request,
  maxBytes: number,
): Promise<{ ok: true; text: string } | { ok: false; status: 400 | 413; error: string }> {
  const declaredLength = request.headers.get("content-length")
  if (declaredLength !== null && /^\d+$/.test(declaredLength.trim())) {
    const contentLength = Number(declaredLength.trim())
    if (contentLength > maxBytes) {
      return { ok: false, status: 413, error: "Release manifest exceeds maximum size" }
    }
  }

  if (!request.body) {
    return { ok: false, status: 400, error: "Missing request body" }
  }

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      totalBytes += value.byteLength
      if (totalBytes > maxBytes) {
        try {
          await reader.cancel()
        } catch {
          // Ignore stream cancellation error after exceeding size limit.
        }
        return { ok: false, status: 413, error: "Release manifest exceeds maximum size" }
      }
      chunks.push(value)
    }
  } catch {
    return { ok: false, status: 400, error: "Failed to read request body" }
  }

  const merged = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }

  try {
    return { ok: true, text: new TextDecoder("utf-8", { fatal: true }).decode(merged) }
  } catch {
    return { ok: false, status: 400, error: "Request body must be valid UTF-8" }
  }
}

export async function POST(req: Request) {
  const token = extractBearerToken(req)
  if (!token) {
    return jsonError("Missing or invalid Authorization header", 401)
  }

  const auth = await verifyGitHubOidcToken(token)
  if (!auth.ok) {
    return jsonError(auth.error, auth.status)
  }

  const bodyResult = await readBoundedBodyText(req, RELEASE_MANIFEST_MAX_BYTES)
  if (!bodyResult.ok) {
    return jsonError(bodyResult.error, bodyResult.status)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(bodyResult.text)
  } catch {
    return jsonError("Invalid JSON payload", 400)
  }

  const validation = validateReleaseManifest(parsed)
  if (!validation.ok) {
    return jsonError(validation.error, 400)
  }

  const serialized = JSON.stringify(validation.manifest)
  if (new TextEncoder().encode(serialized).byteLength > RELEASE_MANIFEST_MAX_BYTES) {
    return jsonError("Release manifest exceeds maximum size", 413)
  }

  let kv: KVNamespace | undefined
  try {
    const { env } = await getCloudflareContext({ async: true })
    kv = env.CACHE_KV
  } catch {
    return jsonError("Release manifest storage unavailable", 503)
  }

  if (!kv) {
    return jsonError("Release manifest storage unavailable", 503)
  }

  try {
    await kv.put(RELEASE_MANIFEST_KV_KEY, serialized)
  } catch {
    return jsonError("Failed to persist release manifest", 503)
  }

  const { manifest } = validation
  return NextResponse.json(
    {
      ok: true,
      syncedAt: manifest.syncedAt,
      installerCount: manifest.installers.length,
      desktopVersion: manifest.desktopUpdater?.version ?? null,
      desktopPlatformCount: manifest.desktopUpdater
        ? Object.keys(manifest.desktopUpdater.platforms).length
        : 0,
    },
    { status: 200, headers: NO_STORE_HEADERS },
  )
}
