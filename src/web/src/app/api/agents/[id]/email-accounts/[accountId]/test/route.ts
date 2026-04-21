import { getCloudflareContext } from "@opennextjs/cloudflare"
import { createDb, queries, DEV_EMAIL_WORKER_URL, TestEmailConnectionSchema } from "@alook/shared"
import { withAuth } from "@/lib/middleware/auth"
import { withWorkspaceMember } from "@/lib/middleware/workspace"
import { writeJSON, writeError, parseBody } from "@/lib/middleware/helpers"

export const POST = withAuth(async (req, ctx) => {
  const ws = await withWorkspaceMember(req, ctx)
  if (ws instanceof Response) return ws

  const { env } = getCloudflareContext()
  const cfEnv = env as Env
  const db = createDb(cfEnv.DB)

  const agentId = ctx.params?.id
  const accountId = ctx.params?.accountId
  if (!agentId || !accountId) return writeError("missing params", 400)

  const existing = await queries.emailAccount.getEmailAccount(db, accountId, ws.workspaceId)
  if (!existing || existing.agentId !== agentId) return writeError("not found", 404)

  let testRes: Response
  try {
    testRes = await cfEnv.EMAIL_WORKER.fetch(`http://internal/imap/test?accountId=${accountId}`, {
      method: "POST",
    })
  } catch {
    testRes = await fetch(`${DEV_EMAIL_WORKER_URL}/imap/test?accountId=${accountId}`, {
      method: "POST",
    })
  }

  const result = await testRes.json()
  return writeJSON(result, testRes.ok ? 200 : 500)
})
