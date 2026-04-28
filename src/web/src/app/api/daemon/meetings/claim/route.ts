import { NextRequest } from "next/server"
import { getCloudflareContext } from "@opennextjs/cloudflare"
import { queries, MeetingStatus } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { meetingToResponse } from "@/lib/api/responses"

const CLAIM_WINDOW_MS = 5 * 60 * 1000

export const POST = withAuth(async (req: NextRequest, ctx) => {
  const { env } = getCloudflareContext()
  const db = getDb((env as Env).DB)

  if (!ctx.workspaceId) {
    return writeError("Forbidden: machine token required", 403)
  }

  const windowEnd = new Date(Date.now() + CLAIM_WINDOW_MS)
  const now = new Date().toISOString()

  const scheduled = await queries.meetingSession.listScheduledMeetings(
    db,
    ctx.workspaceId,
    windowEnd.toISOString(),
  )

  const claimed = []
  for (const meeting of scheduled) {
    const updated = await queries.meetingSession.updateMeetingSession(
      db,
      meeting.id,
      ctx.workspaceId,
      { status: MeetingStatus.JOINING, startedAt: now },
    )
    if (updated) claimed.push(meetingToResponse(updated))
  }

  return writeJSON(claimed)
})
