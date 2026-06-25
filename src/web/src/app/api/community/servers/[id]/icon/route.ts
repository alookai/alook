import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries } from "@alook/shared"

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

  await (ctx.env as unknown as { COMMUNITY_MEDIA: R2Bucket }).COMMUNITY_MEDIA.put(
    key,
    await file.arrayBuffer(),
    { httpMetadata: { contentType: file.type } }
  )

  const updated = await queries.communityServer.updateServer(db, serverId, { icon: key })
  if (!updated) return writeError("server not found", 404)

  return writeJSON(updated)
})
