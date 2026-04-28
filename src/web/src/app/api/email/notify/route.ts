import { NextRequest } from "next/server"
import { getCloudflareContext } from "@opennextjs/cloudflare"
import { queries, TASK_TYPES, MeetingStatus, buildContextKey, extractThreadId, EmailNotifyRequestSchema } from "@alook/shared"
import { getDb } from "@/lib/db"
import { writeJSON, parseBody } from "@/lib/middleware/helpers"
import { TaskService } from "@/lib/services/task"
import { broadcastToUser } from "@/lib/broadcast"

export async function POST(req: NextRequest) {
  const { env } = getCloudflareContext()
  const db = getDb((env as Env).DB)

  const [body, valErr] = await parseBody(req, EmailNotifyRequestSchema);
  if (valErr) return valErr;

  const agent = await queries.agent.getAgent(db, body.agentId, body.workspaceId)

  await queries.email.createEmail(db, {
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

  if (body.isWhitelisted && agent && agent.runtimeId) {
    const conv = await queries.conversation.createConversation(db, {
      workspaceId: agent.workspaceId,
      agentId: agent.id,
      userId: agent.ownerId!,
      title: `Email: ${body.subject}`.slice(0, 50),
      type: TASK_TYPES.EMAIL_NOTIFICATION,
    })
    const prompt = `New email from ${body.from}: ${body.subject}`;
    await queries.message.createMessage(db, {
      conversationId: conv.id,
      role: "user",
      content: prompt,
    })
    const threadId = extractThreadId(body.references, body.inReplyTo, body.messageId);
    const contextKey = buildContextKey(TASK_TYPES.EMAIL_NOTIFICATION, { threadId });
    const taskService = new TaskService(db)
    await taskService.enqueueTask(agent.id, conv.id, agent.workspaceId, prompt, TASK_TYPES.EMAIL_NOTIFICATION, { contextKey })
  }

  if (agent?.ownerId) {
    broadcastToUser(agent.ownerId, { type: "email.received", agentId: body.agentId }).catch(() => {})
  }

  return writeJSON({ ok: true })
}
