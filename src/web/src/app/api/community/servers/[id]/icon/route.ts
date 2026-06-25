import { NextRequest } from "next/server"
import { getCloudflareContext } from "@opennextjs/cloudflare"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries } from "@alook/shared"

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
      "Cache-Control": "public, max-age=3600",
    },
  })
}

export const POST = withAuth(async (req: NextRequest, ctx) => {
  const serverId = ctx.params?.id
  if (!serverId) return writeError("missing server id", 400)

  const db = getDb(ctx.env.DB)

  const member = await queries.communityMember.getMember(db, serverId, ctx.userId)
  if (!member || (member.role !== "owner" && member.role !== "admin")) {
    return writeError("forbidden", 403)
  }

  const formData = await req.formData()
  const file = formData.get("file") as File | null
  if (!file) return writeError("no file provided", 400)

  const fileId = crypto.randomUUID()
  const key = `server-icon/${serverId}/${fileId}`

  await ctx.env.COMMUNITY_MEDIA.put(
    key,
    await file.arrayBuffer(),
    { httpMetadata: { contentType: file.type } }
  )

  const iconUrl = `/api/community/servers/${serverId}/icon`
  const updated = await queries.communityServer.updateServer(db, serverId, { icon: iconUrl })
  if (!updated) return writeError("server not found", 404)

  return writeJSON({ url: iconUrl })
})
