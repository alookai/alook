import { NextRequest } from "next/server"
import { getCloudflareContext } from "@opennextjs/cloudflare"
import { queries, MeetingStatus, EmailNotifyRequestSchema } from "@alook/shared"
import { getDb } from "@/lib/db"
import { writeJSON, parseBody } from "@/lib/middleware/helpers"
import { broadcastToUser } from "@/lib/broadcast"
import { invalidate, cacheKeys } from "@/lib/cache"
import { dispatchEmailToAgent } from "@/lib/services/email-dispatch"

export async function POST(req: NextRequest) {
  const { env } = getCloudflareContext()
  const db = getDb((env as Env).DB)

  const [body, valErr] = await parseBody(req, EmailNotifyRequestSchema);
  if (valErr) return valErr;

  const agent = await queries.agent.getAgent(db, body.agentId, body.workspaceId)

  const email = await queries.email.createEmail(db, {
    agentId: body.agentId,
    workspaceId: body.workspaceId,
    fromEmail: body.from,
    toEmail: body.to ?? "",
    subject: body.subject,
    r2Key: body.r2Key,
    isWhitelisted: body.isWhitelisted,
    forwarded: body.forwarded,
    messageId: body.messageId,
    inReplyTo: body.inReplyTo,
    references: body.references,
    direction: "inbound",
    attachments: body.attachments,
  })

  if (body.meetingInfo && agent) {
    const mi = body.meetingInfo
    await queries.meetingSession.createMeetingSession(db, {
      agentId: body.agentId,
      workspaceId: body.workspaceId,
      title: mi.title || body.subject,
      meetingUrl: mi.meetingUrl,
      status: body.isWhitelisted ? MeetingStatus.SCHEDULED : MeetingStatus.PENDING,
      fromEmail: body.from,
      isWhitelisted: body.isWhitelisted,
      participants: mi.attendees.map(a => a.email),
      scheduledAt: mi.startTime,
    })
  }

  let conversationId: string | null = null;

  if (body.isWhitelisted && agent && agent.runtimeId && agent.ownerId) {
    const result = await dispatchEmailToAgent(db, email, agent, {
      isInternal: body.isInternal,
      senderConversationId: body.senderConversationId,
      senderAgentId: body.senderAgentId,
      traceId: body.traceId,
      sourceTaskId: body.sourceTaskId,
    })
    conversationId = result.conversationId
  }

  const dateStr = new Date().toISOString().slice(0, 10);
  await Promise.all([
    invalidate(cacheKeys.overviewEmailStats(body.workspaceId)),
    invalidate(cacheKeys.overviewTaskStats(body.workspaceId, dateStr)),
  ]);

  if (agent?.ownerId) {
    broadcastToUser(agent.ownerId, { type: "email.received", agentId: body.agentId }).catch(() => {})
  }

  return writeJSON({ ok: true, ...(conversationId ? { conversationId } : {}) })
}
