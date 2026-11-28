import { getCloudflareContext } from "@opennextjs/cloudflare"
import { NextRequest, NextResponse } from "next/server"

const RUNTIME_FILENAME_PATTERN = /^alook-page-runtime-\d+\.\d+\.\d+-[0-9a-f]{12}-[0-9a-f]{12}\.tar\.gz$/
const IMMUTABLE_HEADERS = {
  "Cache-Control": "public, max-age=31536000, immutable",
  "X-Content-Type-Options": "nosniff",
} as const

export async function GET(
  request: NextRequest,
  route: { params: Promise<{ filename: string }> },
): Promise<Response> {
  const { filename } = await route.params
  if (!RUNTIME_FILENAME_PATTERN.test(filename)) {
    return NextResponse.json({ error: "Page runtime archive not found" }, { status: 404 })
  }

  const { env } = await getCloudflareContext({ async: true })
  if (!env.COMMUNITY_MEDIA) {
    return NextResponse.json({ error: "Page runtime storage unavailable" }, { status: 503 })
  }

  const object = await env.COMMUNITY_MEDIA.get(`page-runtime/${filename}`)
  if (!object) {
    return NextResponse.json({ error: "Page runtime archive not found" }, { status: 404 })
  }

  const etag = object.customMetadata?.sha256 ? `"${object.customMetadata.sha256}"` : object.httpEtag
  const headers: Record<string, string> = {
    ...IMMUTABLE_HEADERS,
    "Content-Type": "application/gzip",
    "Content-Length": String(object.size),
    ETag: etag,
  }
  const matched = request.headers
    .get("if-none-match")
    ?.split(",")
    .some((value) => value.trim().replace(/^W\//, "") === etag || value.trim() === "*")
  if (matched) {
    await object.body.cancel()
    return new Response(null, { status: 304, headers })
  }

  return new Response(object.body, { status: 200, headers })
}
