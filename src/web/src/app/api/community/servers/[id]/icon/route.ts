import { NextRequest } from "next/server"
import { getCloudflareContext } from "@opennextjs/cloudflare"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries, CACHE_SHORT } from "@alook/shared"
import { requireServerAdmin } from "@/lib/community/permissions"
import { handleServerIconUpload } from "@/lib/community/upload"

export const GET = async (_req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const { id: serverId } = await params
  if (!serverId) return new Response("not found", { status: 404 })

  const { env } = await getCloudflareContext({ async: true })
  const db = getDb(env.DB)
  const server = await queries.communityServer.getServer(db, serverId)
  if (!server?.icon) return new Response("no icon", { status: 404 })

  const objects = await env.COMMUNITY_MEDIA.list({ prefix: `server-icon/${serverId}/` })
  const latest = objects.objects.sort((a, b) => (b.uploaded?.getTime() ?? 0) - (a.uploaded?.getTime() ?? 0))[0]
  if (!latest) return new Response("not found", { status: 404 })

  const obj = await env.COMMUNITY_MEDIA.get(latest.key)
  if (!obj) return new Response("not found", { status: 404 })

  return new Response(obj.body, {
    headers: {
      "Content-Type": obj.httpMetadata?.contentType ?? "image/png",
      "Cache-Control": CACHE_SHORT,
    },
  })
}

export const POST = withAuth(async (req: NextRequest, ctx) => {
  const serverId = ctx.params?.id
  if (!serverId) return writeError("missing server id", 400)

  const db = getDb(ctx.env.DB)
  const auth = await requireServerAdmin(db, serverId, ctx.userId)
  if (!auth.ok) return writeError(auth.error, auth.status)

  const result = await handleServerIconUpload(req, ctx.env, serverId)
  if (!result.ok) return result.response

  const iconUrl = `/api/community/servers/${serverId}/icon`
  const updated = await queries.communityServer.updateServer(db, serverId, { icon: iconUrl })
  if (!updated) return writeError("server not found", 404)

  return writeJSON({ url: iconUrl })
})
