import { NextRequest } from "next/server"
import { getCloudflareContext } from "@opennextjs/cloudflare"
import { queries, MeetingStatus } from "@alook/shared"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"

export async function POST(req: NextRequest) {
  const { env } = getCloudflareContext()
  const cfEnv = env as Env
  const db = getDb(cfEnv.DB)

  let body: {
    meetingId?: string
    workspaceId?: string
    status?: "completed" | "failed"
    transcript?: string
    error?: string
  }
  try {
    body = await req.json() as typeof body
  } catch {
    return writeError("invalid request body", 400)
  }

  if (!body.meetingId || !body.workspaceId || !body.status) {
    return writeError("meetingId, workspaceId, and status are required", 400)
  }

  const meeting = await queries.meetingSession.getMeetingSession(
    db,
    body.meetingId,
    body.workspaceId
  )
  if (!meeting) return writeError("meeting not found", 404)

  let transcriptR2Key: string | undefined
  if (body.transcript) {
    transcriptR2Key = `meetings/${body.meetingId}/transcript`
    await cfEnv.EMAIL_BUCKET.put(transcriptR2Key, body.transcript, {
      httpMetadata: { contentType: "text/plain" },
    })
  }

  const updated = await queries.meetingSession.updateMeetingSession(
    db,
    body.meetingId,
    body.workspaceId,
    {
      status: body.status === "completed" ? MeetingStatus.COMPLETED : MeetingStatus.FAILED,
      completedAt: new Date().toISOString(),
      transcriptR2Key,
      error: body.error,
    }
  )

  return writeJSON({ ok: true, meeting: updated })
}
