import { NextRequest } from "next/server"
import { getCloudflareContext } from "@opennextjs/cloudflare"
import { createDb, queries, TASK_TYPES, buildContextKey, extractThreadId } from "@alook/shared"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { TaskService } from "@/lib/services/task"
import { broadcastToUser } from "@/lib/broadcast"

export async function POST(req: NextRequest) {
  const { env } = getCloudflareContext()
  const db = createDb((env as Env).DB)

  let body: { agentId: string; workspaceId: string; r2Key: string; from: string; to?: string; subject: string; isWhitelisted: boolean; forwarded?: boolean; messageId?: string; inReplyTo?: string; references?: string }
  try { body = await req.json() } catch { return writeError("invalid body", 400) }

  const agent = await queries.agent.getAgent(db, body.agentId, body.workspaceId)

  await queries.email.createEmail(db, {
    agentId: body.agentId,
    workspaceId: body.workspaceId,
    fromEmail: body.from,
    toEmail: body.to ?? "",
    subject: body.subject,
    r2Key: body.r2Key,
    isWhitelisted: body.isWhitelisted,
    forwarded: body.forwarded ?? false,
    messageId: body.messageId ?? "",
    inReplyTo: body.inReplyTo ?? "",
    references: body.references ?? "",
  })

  if (body.isWhitelisted && agent && agent.runtimeId) {
    const conv = await queries.conversation.createConversation(db, {
      workspaceId: agent.workspaceId,
      agentId: agent.id,
      userId: agent.ownerId!,
      title: `Email: ${body.subject}`.slice(0, 50),
      type: TASK_TYPES.EMAIL_NOTIFICATION,
    })
    const threadId = extractThreadId(body.references, body.inReplyTo, body.messageId);
    const contextKey = buildContextKey(TASK_TYPES.EMAIL_NOTIFICATION, { threadId });
    const taskService = new TaskService(db)
    await taskService.enqueueTask(agent.id, conv.id, agent.workspaceId, `New email from ${body.from}: ${body.subject}`, TASK_TYPES.EMAIL_NOTIFICATION, { contextKey })
  }

  // Notify UI for all emails (whitelisted or not)
  if (agent?.ownerId) {
    broadcastToUser(agent.ownerId, { type: "email.received", agentId: body.agentId }).catch(() => {})
  }

  return writeJSON({ ok: true })
}
