import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries } from "@alook/shared"

export const POST = withAuth(async (req: NextRequest, ctx) => {
  const dmId = ctx.params?.id
  if (!dmId) return writeError("missing dm id", 400)

  const db = getDb(ctx.env.DB)

  const dm = await queries.communityDm.getDM(db, dmId)
  if (!dm) return writeError("dm not found", 404)
  if (dm.user1Id !== ctx.userId && dm.user2Id !== ctx.userId) {
    return writeError("forbidden", 403)
  }

  const formData = await req.formData()
  const file = formData.get("file") as File | null
  if (!file) return writeError("no file provided", 400)

  const fileId = crypto.randomUUID()
  const key = `dm/${dmId}/${fileId}/${file.name}`

  await ctx.env.COMMUNITY_MEDIA.put(
    key,
    await file.arrayBuffer(),
    { httpMetadata: { contentType: file.type } }
  )

  return writeJSON({
    url: `/api/community/media/${key}`,
    filename: file.name,
    contentType: file.type,
    size: file.size,
  })
})
