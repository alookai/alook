import { NextRequest } from "next/server"
import { getCloudflareContext } from "@opennextjs/cloudflare"
import { queries, MeetingStatus, DEV_EMAIL_WORKER_URL } from "@alook/shared"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"

export const POST = withAuth(async (req: NextRequest, ctx) => {
  const { env } = getCloudflareContext()
  const cfEnv = env as Env
  const db = getDb(cfEnv.DB)

  if (!ctx.workspaceId) {
    return writeError("Forbidden: machine token required", 403)
  }

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

  if (body.workspaceId !== ctx.workspaceId) {
    return writeError("workspace mismatch", 403)
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

  if (body.status === "completed" && body.transcript && meeting.participants.length > 0) {
    const htmlBody = `
      <h2>Meeting Transcript</h2>
      <p><strong>Meeting:</strong> ${meeting.meetingUrl}</p>
      <pre style="white-space: pre-wrap; font-family: monospace;">${body.transcript}</pre>
    `.trim()

    for (const email of meeting.participants) {
      const payload = JSON.stringify({
        to: email,
        subject: `Meeting Transcript: ${meeting.title || "Untitled"}`,
        htmlBody,
      })
      const init: RequestInit = {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
      }

      try {
        await cfEnv.EMAIL_WORKER.fetch("http://internal/send/agent", init)
      } catch {
        try {
          await fetch(`${DEV_EMAIL_WORKER_URL}/send/agent`, init)
        } catch {
          // Best-effort
        }
      }
    }
  }

  return writeJSON({ ok: true, meeting: updated })
})
