import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { requireDMParticipant } from "@/lib/community/permissions"
import { handleAttachmentUpload } from "@/lib/community/upload"

export const POST = withAuth(async (req: NextRequest, ctx) => {
  const dmId = ctx.params?.id
  if (!dmId) return writeError("missing dm id", 400)

  const db = getDb(ctx.env.DB)
  const auth = await requireDMParticipant(db, dmId, ctx.userId)
  if (!auth.ok) return writeError(auth.error, auth.status)

  const result = await handleAttachmentUpload(req, ctx.env, "dm", dmId)
  if (!result.ok) return result.response

  return writeJSON({
    url: result.url,
    filename: result.filename,
    contentType: result.contentType,
    size: result.size,
  })
})
