import { NextRequest } from "next/server"
import { getCloudflareContext } from "@opennextjs/cloudflare"
import { nanoid } from "nanoid"
import { queries, MeetingStatus, DEV_WEB_URL, buildMimeMessage } from "@alook/shared"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { log } from "@/lib/logger"

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

  if (body.status === "completed" && body.transcript) {
    const agent = await queries.agent.getAgent(db, meeting.agentId, body.workspaceId)

    if (agent?.emailHandle) {
      const messageId = `<meeting-${body.meetingId}@alook.ai>`
      const existing = await queries.email.getEmailByMessageId(db, messageId, body.workspaceId)
      if (!existing) {
        const fromAddr = "no-reply@alook.ai"
        const toAddr = `${agent.emailHandle}@alook.ai`
        const subject = `Meeting transcript: ${meeting.title || "Untitled"}`

        const rawMime = buildMimeMessage({
          from: fromAddr,
          to: toAddr,
          subject,
          messageId,
          body: body.transcript,
          bodyType: "text/plain",
        })

        const emailR2Key = `emails/${nanoid()}/raw`
        await cfEnv.EMAIL_BUCKET.put(emailR2Key, rawMime, {
          httpMetadata: { contentType: "message/rfc822" },
        })

        const notifyPayload = JSON.stringify({
          agentId: agent.id,
          workspaceId: body.workspaceId,
          r2Key: emailR2Key,
          from: fromAddr,
          to: toAddr,
          subject,
          isWhitelisted: true,
          forwarded: false,
          messageId,
          inReplyTo: "",
          references: "",
        })
        const notifyInit: RequestInit = {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: notifyPayload,
        }

        try {
          await cfEnv.WORKER_SELF_REFERENCE!.fetch("http://internal/api/email/notify", notifyInit)
        } catch {
          try {
            await fetch(`${DEV_WEB_URL}/api/email/notify`, notifyInit)
          } catch (e) {
            log.warn("meeting-callback: email notify failed", { err: String(e) })
          }
        }
      }
    }
  }

  return writeJSON({ ok: true, meeting: updated })
})
