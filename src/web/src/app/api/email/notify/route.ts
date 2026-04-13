import { NextRequest } from "next/server"
import { getCloudflareContext } from "@opennextjs/cloudflare"
import { createDb, queries } from "@alook/shared"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { TaskService } from "@/lib/services/task"
import { broadcastToUser } from "@/lib/broadcast"

export async function POST(req: NextRequest) {
  const { env } = getCloudflareContext()
  const db = createDb((env as Env).DB)

  let body: { agentId: string; r2Key: string; from: string; to?: string; subject: string; isWhitelisted: boolean; forwarded?: boolean }
  try { body = await req.json() } catch { return writeError("invalid body", 400) }

  await queries.email.createEmail(db, {
    agentId: body.agentId,
    fromEmail: body.from,
    toEmail: body.to ?? "",
    subject: body.subject,
    r2Key: body.r2Key,
    isWhitelisted: body.isWhitelisted,
    forwarded: body.forwarded ?? false,
  })

  const agent = await queries.agent.getAgent(db, body.agentId)

  if (body.isWhitelisted && agent && agent.runtimeId) {
    const conv = await queries.conversation.createConversation(db, {
      workspaceId: agent.workspaceId,
      agentId: agent.id,
      userId: agent.ownerId!,
      title: `Email: ${body.subject}`.slice(0, 50),
    })
    const taskService = new TaskService(db)
    await taskService.enqueueTask(agent.id, conv.id, agent.workspaceId, `New email from ${body.from}: ${body.subject}`)
  }

  // Notify UI for all emails (whitelisted or not)
  if (agent?.ownerId) {
    broadcastToUser(agent.ownerId, { type: "email.received", agentId: body.agentId }).catch(() => {})
  }

  return writeJSON({ ok: true })
}
