import { getCloudflareContext } from "@opennextjs/cloudflare"
import { queries, UpdateEmailAccountSchema, DEV_EMAIL_WORKER_URL } from "@alook/shared"
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

async function callEmailWorker(cfEnv: Env, path: string, method = "POST") {
  try {
    await cfEnv.EMAIL_WORKER.fetch(`http://internal${path}`, { method })
  } catch {
    await fetch(`${DEV_EMAIL_WORKER_URL}${path}`, { method }).catch(() => {})
  }
}

export const PATCH = withAuth(async (req, ctx) => {
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

  const [body, err] = await parseBody(req, UpdateEmailAccountSchema)
  if (err) return err

  const secret = cfEnv.ENCRYPTION_KEY
  if (!secret) return writeError("encryption not configured", 500)

  const data: Record<string, unknown> = {}
  if (body.emailAddress !== undefined) data.emailAddress = body.emailAddress
  if (body.displayName !== undefined) data.displayName = body.displayName
  if (body.imapHost !== undefined) data.imapHost = body.imapHost
  if (body.imapPort !== undefined) data.imapPort = body.imapPort
  if (body.imapUsername !== undefined) data.imapUsername = encrypt(body.imapUsername, secret)
  if (body.imapPassword !== undefined) data.imapPassword = encrypt(body.imapPassword, secret)
  if (body.imapTls !== undefined) data.imapTls = body.imapTls
  if (body.smtpHost !== undefined) data.smtpHost = body.smtpHost
  if (body.smtpPort !== undefined) data.smtpPort = body.smtpPort
  if (body.smtpUsername !== undefined) data.smtpUsername = encrypt(body.smtpUsername, secret)
  if (body.smtpPassword !== undefined) data.smtpPassword = encrypt(body.smtpPassword, secret)
  if (body.smtpTls !== undefined) data.smtpTls = body.smtpTls
  if (body.pollIntervalSeconds !== undefined) data.pollIntervalSeconds = body.pollIntervalSeconds

  const updated = await queries.emailAccount.updateEmailAccount(db, accountId, ws.workspaceId, data)
  if (!updated) return writeError("update failed", 500)

  await invalidate(cacheKeys.allEmailAccounts(ws.workspaceId));
  await invalidate(cacheKeys.overviewEmailAccounts(ws.workspaceId));

  const hasCredentialChange = body.imapUsername || body.imapPassword || body.smtpUsername || body.smtpPassword || body.imapHost || body.smtpHost
  if (hasCredentialChange) {
    await callEmailWorker(cfEnv, `/imap/stop?accountId=${accountId}`)
    await callEmailWorker(cfEnv, `/imap/start?accountId=${accountId}`)
  }

  return writeJSON(accountToResponse(updated))
})

export const DELETE = withAuth(async (req, ctx) => {
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

  await callEmailWorker(cfEnv, `/imap/stop?accountId=${accountId}`)

  const deleted = await queries.emailAccount.deleteEmailAccount(db, accountId, ws.workspaceId)
  if (!deleted) return writeError("delete failed", 500)

  await invalidate(cacheKeys.allEmailAccounts(ws.workspaceId));
  await invalidate(cacheKeys.overviewEmailAccounts(ws.workspaceId));

  return writeJSON({ ok: true })
})
