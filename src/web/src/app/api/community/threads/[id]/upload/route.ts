import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries } from "@alook/shared"

export const POST = withAuth(async (req: NextRequest, ctx) => {
  const threadId = ctx.params?.id
  if (!threadId) return writeError("missing thread id", 400)

  const db = getDb(ctx.env.DB)

  const thread = await queries.communityThread.getThread(db, threadId)
  if (!thread) return writeError("thread not found", 404)

  const channel = await queries.communityChannel.getChannel(db, thread.channelId)
  if (!channel) return writeError("channel not found", 404)

  const member = await queries.communityMember.getMember(db, channel.serverId, ctx.userId)
  if (!member) return writeError("forbidden", 403)

  const formData = await req.formData()
  const file = formData.get("file") as File | null
  if (!file) return writeError("no file provided", 400)

  const fileId = crypto.randomUUID()
  const key = `thread/${threadId}/${fileId}/${file.name}`

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
