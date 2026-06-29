import { NextRequest } from "next/server"
import { getCloudflareContext } from "@opennextjs/cloudflare"
import { CACHE_IMMUTABLE } from "@alook/shared"

export const GET = async (req: NextRequest, { params }: { params: Promise<{ key: string[] }> }) => {
  const { key } = await params
  if (!key?.length) return new Response("not found", { status: 404 })

  const r2Key = key.join("/")
  const { env } = await getCloudflareContext({ async: true })
  const obj = await env.COMMUNITY_MEDIA.get(r2Key)
  if (!obj) return new Response("not found", { status: 404 })

  const isImage = obj.httpMetadata?.contentType?.startsWith("image/")
  return new Response(obj.body, {
    headers: {
      "Content-Type": obj.httpMetadata?.contentType ?? "application/octet-stream",
      "Content-Disposition": isImage ? "inline" : `attachment; filename="${key[key.length - 1]}"`,
      "Cache-Control": CACHE_IMMUTABLE,
    },
  })
}
