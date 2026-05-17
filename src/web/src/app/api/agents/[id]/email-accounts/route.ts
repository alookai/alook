import { getCloudflareContext } from "@opennextjs/cloudflare"
import { queries, CreateEmailAccountSchema, DEV_EMAIL_WORKER_URL } from "@alook/shared"
import { getDb } from "@/lib/db"
import { encrypt } from "@alook/shared/crypto"
import { withAuth } from "@/lib/middleware/auth"
import { withWorkspaceMember } from "@/lib/middleware/workspace"
import { writeJSON, writeError, parseBody, formatTimestamp, formatTimestampNullable } from "@/lib/middleware/helpers"
import { invalidate, cacheKeys } from "@/lib/cache"

type AgentEmailAccountRow = Awaited<ReturnType<typeof queries.emailAccount.getEmailAccountsByAgent>>[number]

function accountToResponse(a: AgentEmailAccountRow) {
  return {
    id: a.id,
    agent_id: a.agentId,
    workspace_id: a.workspaceId,
    email_address: a.emailAddress,
    display_name: a.displayName,
    imap_host: a.imapHost,
    imap_port: a.imapPort,
    imap_tls: !!a.imapTls,
    smtp_host: a.smtpHost,
    smtp_port: a.smtpPort,
    smtp_tls: a.smtpTls,
    poll_interval_seconds: a.pollIntervalSeconds,
    last_synced_at: formatTimestampNullable(a.lastSyncedAt),
    status: a.status,
    error_message: a.errorMessage,
    created_at: formatTimestamp(a.createdAt),
    updated_at: formatTimestamp(a.updatedAt),
  }
}

export const GET = withAuth(async (req, ctx) => {
  const ws = await withWorkspaceMember(req, ctx)
  if (ws instanceof Response) return ws

  const { env } = getCloudflareContext()
  const db = getDb((env as Env).DB)

  const agentId = ctx.params?.id
  if (!agentId) return writeError("agent id is required", 400)

  const agent = await queries.agent.getAgent(db, agentId, ws.workspaceId, ctx.userId)
  if (!agent) return writeError("agent not found", 404)

  const accounts = await queries.emailAccount.getEmailAccountsByAgent(db, agentId, ws.workspaceId)
  return writeJSON(accounts.map(accountToResponse))
})

export const POST = withAuth(async (req, ctx) => {
  const ws = await withWorkspaceMember(req, ctx)
  if (ws instanceof Response) return ws

  const { env } = getCloudflareContext()
  const cfEnv = env as Env
  const db = getDb(cfEnv.DB)

  const agentId = ctx.params?.id
  if (!agentId) return writeError("agent id is required", 400)

  const agent = await queries.agent.getAgent(db, agentId, ws.workspaceId, ctx.userId)
  if (!agent) return writeError("agent not found", 404)

  const [body, err] = await parseBody(req, CreateEmailAccountSchema)
  if (err) return err

  const secret = cfEnv.ENCRYPTION_KEY
  if (!secret) return writeError("encryption not configured", 500)

  const account = await queries.emailAccount.createEmailAccount(db, {
    agentId,
    workspaceId: ws.workspaceId,
    emailAddress: body.emailAddress,
    displayName: body.displayName,
    imapHost: body.imapHost,
    imapPort: body.imapPort,
    imapUsername: encrypt(body.imapUsername, secret),
    imapPassword: encrypt(body.imapPassword, secret),
    imapTls: body.imapTls,
    smtpHost: body.smtpHost,
    smtpPort: body.smtpPort,
    smtpUsername: encrypt(body.smtpUsername, secret),
    smtpPassword: encrypt(body.smtpPassword, secret),
    smtpTls: body.smtpTls,
    pollIntervalSeconds: body.pollIntervalSeconds,
  })

  try {
    await cfEnv.EMAIL_WORKER.fetch(`http://internal/imap/start?accountId=${account.id}`, {
      method: "POST",
    })
  } catch {
    await fetch(`${DEV_EMAIL_WORKER_URL}/imap/start?accountId=${account.id}`, {
      method: "POST",
    }).catch(() => {})
  }

  await invalidate(cacheKeys.emailAccountsByAgent(ws.workspaceId, agentId));

  return writeJSON(accountToResponse(account), 201)
})
