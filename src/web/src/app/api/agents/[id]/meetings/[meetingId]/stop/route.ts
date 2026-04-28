import { NextRequest } from "next/server"
import { getCloudflareContext } from "@opennextjs/cloudflare"
import { queries, DEV_BROWSER_WORKER_URL, MeetingStatus } from "@alook/shared"
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

  const meetingId = ctx.params?.meetingId
  if (!meetingId) return writeError("meeting id is required", 400)

  const meeting = await queries.meetingSession.getMeetingSession(db, meetingId, ws.workspaceId)
  if (!meeting) return writeError("meeting not found", 404)

  if (meeting.status !== MeetingStatus.RECORDING && meeting.status !== MeetingStatus.JOINING) {
    return writeError("meeting is not active", 400)
  }

  if (!meeting.workerSessionId) {
    return writeError("meeting has no active worker session", 400)
  }

  let transcript = ""
  try {
    let workerRes: Response
    try {
      workerRes = await cfEnv.BROWSER_WORKER.fetch(
        `http://internal/meeting/${meeting.workerSessionId}/stop`,
        { method: "POST" }
      )
    } catch {
      workerRes = await fetch(
        `${DEV_BROWSER_WORKER_URL}/meeting/${meeting.workerSessionId}/stop`,
        { method: "POST" }
      )
    }

    if (workerRes.ok) {
      const result = await workerRes.json() as { transcript?: string }
      transcript = result.transcript ?? ""
    }
  } catch {
    // Best-effort stop
  }

  let transcriptR2Key: string | undefined
  if (transcript) {
    transcriptR2Key = `meetings/${meetingId}/transcript`
    await cfEnv.EMAIL_BUCKET.put(transcriptR2Key, transcript, {
      httpMetadata: { contentType: "text/plain" },
    })
  }

  const updated = await queries.meetingSession.updateMeetingSession(db, meetingId, ws.workspaceId, {
    status: MeetingStatus.COMPLETED,
    completedAt: new Date().toISOString(),
    transcriptR2Key,
  })

  return writeJSON({ ...meetingToResponse(updated), transcript })
})
