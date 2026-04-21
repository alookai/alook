import { DurableObject } from "cloudflare:workers"
import { CFImap } from "cf-imap"
import { nanoid } from "nanoid"
import { createDb, queries, createLogger } from "@alook/shared"
import { decrypt } from "@alook/shared/crypto"
import type { EmailEnv } from "./types"

const log = createLogger({ service: "imap-poller" })

const MAX_BACKOFF_MS = 15 * 60 * 1000
const MAX_EMAILS_PER_POLL = 50

export class ImapPollerDO extends DurableObject<EmailEnv> {
  private accountId: string | null = null

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === "/start" && request.method === "POST") {
      const body = await request.json<{ accountId: string }>()
      this.accountId = body.accountId
      await this.ctx.storage.put("accountId", body.accountId)
      await this.ctx.storage.put("backoffMs", 0)
      await this.ctx.storage.setAlarm(Date.now() + 1000)
      return Response.json({ ok: true })
    }

    if (url.pathname === "/stop" && request.method === "POST") {
      await this.ctx.storage.deleteAlarm()
      await this.ctx.storage.deleteAll()
      return Response.json({ ok: true })
    }

    if (url.pathname === "/sync" && request.method === "POST") {
      await this.pollImap()
      return Response.json({ ok: true })
    }

    if (url.pathname === "/status" && request.method === "GET") {
      const accountId = await this.ctx.storage.get<string>("accountId")
      if (!accountId) return Response.json({ status: "stopped" })
      const db = createDb(this.env.DB)
      const account = await queries.emailAccount.getEmailAccountById(db, accountId)
      if (!account) return Response.json({ status: "not_found" })
      return Response.json({
        status: account.status,
        lastSyncedAt: account.lastSyncedAt,
        errorMessage: account.errorMessage,
      })
    }

    return Response.json({ error: "not found" }, { status: 404 })
  }

  async alarm(): Promise<void> {
    await this.pollImap()
  }

  private async pollImap(): Promise<void> {
    const accountId = this.accountId ?? await this.ctx.storage.get<string>("accountId")
    if (!accountId) return

    const db = createDb(this.env.DB)
    const account = await queries.emailAccount.getEmailAccountById(db, accountId)
    if (!account) {
      await this.ctx.storage.deleteAlarm()
      await this.ctx.storage.deleteAll()
      return
    }

    const pollLog = log.child({ accountId, agentId: account.agentId })
    let imap: CFImap | null = null

    try {
      const secret = this.env.ENCRYPTION_KEY
      if (!secret) throw new Error("ENCRYPTION_KEY not configured")

      const imapUsername = decrypt(account.imapUsername, secret)
      const imapPassword = decrypt(account.imapPassword, secret)

      imap = new CFImap({
        host: account.imapHost,
        port: account.imapPort,
        tls: account.imapTls as unknown as boolean,
        auth: { username: imapUsername, password: imapPassword },
      })

      await imap.connect()
      await imap.selectFolder("INBOX")

      const unseenSeqs = await imap.searchEmails({ seen: false })
      pollLog.info("search complete", { unseen: unseenSeqs.length })

      if (unseenSeqs.length === 0) {
        await queries.emailAccount.updateEmailAccount(db, accountId, account.workspaceId, {
          lastSyncedAt: new Date().toISOString(),
          status: "active",
          errorMessage: "",
        })
        await this.scheduleNext(account.pollIntervalSeconds * 1000)
        await imap.logout()
        return
      }

      const sorted = [...unseenSeqs].sort((a, b) => a - b)
      const batch = sorted.slice(0, MAX_EMAILS_PER_POLL)
      const start = batch[0]!
      const end = batch[batch.length - 1]!

      // peek:true to work around cf-imap bug where peek:false generates "BODYfalse" (invalid IMAP)
      const fetched = await imap.fetchEmails({
        folder: "INBOX",
        limit: [start, end],
        fetchBody: true,
        peek: true,
      })

      pollLog.info("fetched emails", { count: fetched.length })

      // Mark fetched emails as \Seen since we used peek:true above
      const encoder = new TextEncoder()
      const decoder = new TextDecoder()
      const writer = (imap as any).writer as WritableStreamDefaultWriter
      const reader = (imap as any).reader as ReadableStreamDefaultReader
      await writer.write(encoder.encode(`A6 STORE ${start}:${end} +FLAGS (\\Seen)\r\n`))
      await decoder.decode((await reader.read()).value)

      for (const email of fetched) {
        const r2Id = nanoid()
        const r2Key = `emails/${r2Id}/raw`
        await this.env.EMAIL_BUCKET.put(r2Key, email.raw, {
          httpMetadata: { contentType: "message/rfc822" },
        })

        const fromEmail = email.from
        const isWhitelisted = await queries.whitelist.isWhitelisted(
          db, account.agentId, account.workspaceId, fromEmail
        )

        await this.notifyWeb({
          agentId: account.agentId,
          workspaceId: account.workspaceId,
          r2Key,
          from: fromEmail,
          to: account.emailAddress,
          subject: email.subject || "",
          isWhitelisted,
          messageId: email.messageID || "",
          inReplyTo: "",
          references: "",
        })
      }

      await queries.emailAccount.updateEmailAccount(db, accountId, account.workspaceId, {
        lastSyncedAt: new Date().toISOString(),
        status: "active",
        errorMessage: "",
      })

      await this.ctx.storage.put("backoffMs", 0)
      await this.scheduleNext(account.pollIntervalSeconds * 1000)
      await imap.logout()
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      pollLog.error("poll failed", { error: msg })

      const isAuthError = /auth|login|credentials/i.test(msg)

      await queries.emailAccount.updateEmailAccount(db, accountId, account.workspaceId, {
        status: "error",
        errorMessage: msg.slice(0, 500),
      })

      if (isAuthError) {
        pollLog.warn("auth error — stopping polling, user must fix credentials")
        await this.ctx.storage.deleteAlarm()
        return
      }

      const currentBackoff = (await this.ctx.storage.get<number>("backoffMs")) ?? 0
      const nextBackoff = Math.min(
        currentBackoff === 0 ? account.pollIntervalSeconds * 1000 : currentBackoff * 2,
        MAX_BACKOFF_MS
      )
      await this.ctx.storage.put("backoffMs", nextBackoff)
      await this.scheduleNext(nextBackoff)

      try { await imap?.logout() } catch { /* ignore */ }
    }
  }

  private async scheduleNext(delayMs: number): Promise<void> {
    await this.ctx.storage.setAlarm(Date.now() + delayMs)
  }

  private async notifyWeb(payload: Record<string, unknown>): Promise<void> {
    const traceId = nanoid(12)
    const body = JSON.stringify(payload)
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Trace-Id": traceId,
    }

    const init: RequestInit = { method: "POST", headers, body }

    try {
      const res = await this.env.WEB_SERVICE.fetch("http://internal/api/email/notify", init)
      if (!res.ok) throw new Error(`WEB_SERVICE responded ${res.status}`)
    } catch (serviceErr) {
      try {
        const { DEV_WEB_URL } = await import("@alook/shared")
        const fallback = await fetch(`${DEV_WEB_URL}/api/email/notify`, init)
        if (!fallback.ok) throw new Error(`fallback responded ${fallback.status}`)
      } catch {
        throw serviceErr instanceof Error ? serviceErr : new Error(String(serviceErr))
      }
    }
  }
}
