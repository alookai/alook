import { getCloudflareContext } from "@opennextjs/cloudflare"
import { queries } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { withWorkspaceMember } from "@/lib/middleware/workspace"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { emailToResponse } from "@/lib/api/responses"
import { broadcastToUser } from "@/lib/broadcast"
import { invalidate, cacheKeys } from "@/lib/cache"
import { dispatchEmailToAgent } from "@/lib/services/email-dispatch"

export const POST = withAuth(async (req, ctx) => {
  const ws = await withWorkspaceMember(req, ctx)
  if (ws instanceof Response) return ws

  const { env } = getCloudflareContext()
  const db = getDb((env as Env).DB)

  const id = ctx.params?.id
  if (!id) return writeError("email id is required", 400)

  const email = await queries.email.getEmailById(db, id, ws.workspaceId)
  if (!email) return writeError("email not found", 404)

  if (email.isWhitelisted) return writeError("email is already trusted", 400)
  if (email.direction !== "inbound") return writeError("only inbound emails can be trusted", 400)

  const agent = await queries.agent.getAgent(db, email.agentId, ws.workspaceId, ctx.userId)
  if (!agent || !agent.runtimeId || !agent.ownerId) return writeError("agent not found or has no runtime", 404)

  const updatedEmail = await queries.email.updateEmailWhitelisted(db, id, ws.workspaceId, true)
  if (!updatedEmail) return writeError("failed to update email", 500)

  const { conversationId } = await dispatchEmailToAgent(db, updatedEmail, agent)

  const dateStr = new Date().toISOString().slice(0, 10)
  await Promise.all([
    invalidate(cacheKeys.overviewEmailStats(ws.workspaceId)),
    invalidate(cacheKeys.overviewTaskStats(ws.workspaceId, dateStr)),
  ])

  if (agent.ownerId) {
    broadcastToUser(agent.ownerId, { type: "email.received", agentId: agent.id }).catch(() => {})
  }

  return writeJSON({ ok: true, email: emailToResponse(updatedEmail), conversationId })
})
