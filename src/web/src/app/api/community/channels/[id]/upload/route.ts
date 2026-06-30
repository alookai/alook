import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { requireChannelMember } from "@/lib/community/permissions"
import { handleAttachmentUpload } from "@/lib/community/upload"

export const POST = withAuth(async (req: NextRequest, ctx) => {
  const channelId = ctx.params?.id
  if (!channelId) return writeError("missing channel id", 400)

  const db = getDb(ctx.env.DB)
  const auth = await requireChannelMember(db, channelId, ctx.userId)
  if (!auth.ok) return writeError(auth.error, auth.status)

  const result = await handleAttachmentUpload(req, ctx.env, "channel", channelId)
  if (!result.ok) return result.response

  return writeJSON({
    url: result.url,
    filename: result.filename,
    contentType: result.contentType,
    size: result.size,
  })
})
