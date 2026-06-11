import { NextRequest } from "next/server"
import { getCloudflareContext } from "@opennextjs/cloudflare"
import { queries, MeetingStatus } from "@alook/shared"
import { withAuth } from "@/lib/middleware/auth"
import { withWorkspaceMember } from "@/lib/middleware/workspace"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { meetingToResponse } from "@/lib/api/responses"
import { getDb } from "@/lib/db"

export const POST = withAuth(async (req: NextRequest, ctx) => {
  const ws = await withWorkspaceMember(req, ctx)
  if (ws instanceof Response) return ws

  const { env } = getCloudflareContext()
  const cfEnv = env as Env
  const db = getDb(cfEnv.DB)

  const agentId = ctx.params?.id
  if (!agentId) return writeError("agent id is required", 400)

  const agent = await queries.agent.getAgent(db, agentId, ws.workspaceId, ctx.userId)
  if (!agent) return writeError("not found", 404)

  const meetingId = ctx.params?.meetingId
  if (!meetingId) return writeError("meeting id is required", 400)

  const meeting = await queries.meetingSession.getMeetingSession(db, meetingId, ws.workspaceId)
  if (!meeting) return writeError("not found", 404)

  if (meeting.status !== MeetingStatus.RECORDING && meeting.status !== MeetingStatus.JOINING) {
    return writeError("meeting is not active", 400)
  }

  const updated = await queries.meetingSession.updateMeetingSession(db, meetingId, ws.workspaceId, {
    status: MeetingStatus.COMPLETED,
    completedAt: new Date().toISOString(),
  })
  if (!updated) return writeError("meeting not found", 404)

  return writeJSON(meetingToResponse(updated))
})
