import { getCloudflareContext } from "@opennextjs/cloudflare"
import { queries, DEV_EMAIL_WORKER_URL } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { withWorkspaceMember } from "@/lib/middleware/workspace"
import { writeJSON, writeError } from "@/lib/middleware/helpers"

export const POST = withAuth(async (req, ctx) => {
  const ws = await withWorkspaceMember(req, ctx)
  if (ws instanceof Response) return ws

  const { env } = getCloudflareContext()
  const cfEnv = env as Env
  const db = getDb(cfEnv.DB)

  const agentId = ctx.params?.id
  const accountId = ctx.params?.accountId
  if (!agentId || !accountId) return writeError("missing params", 400)

  const agent = await queries.agent.getAgent(db, agentId, ws.workspaceId, ctx.userId)
  if (!agent) return writeError("not found", 404)

  const existing = await queries.emailAccount.getEmailAccountScoped(db, accountId, agentId, ws.workspaceId)
  if (!existing) return writeError("not found", 404)

  try {
    await cfEnv.EMAIL_WORKER.fetch(`http://internal/imap/sync?accountId=${accountId}`, {
      method: "POST",
    })
  } catch {
    await fetch(`${DEV_EMAIL_WORKER_URL}/imap/sync?accountId=${accountId}`, {
      method: "POST",
    }).catch(() => {})
  }

  return writeJSON({ ok: true })
})
