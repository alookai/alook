import { DurableObject } from "cloudflare:workers"
import { CFImap } from "cf-imap"
import PostalMime from "postal-mime"
import { nanoid } from "nanoid"
import { createDb, queries, createLogger } from "@alook/shared"
import { decrypt } from "@alook/shared/crypto"
import type { EmailEnv } from "./types"

const log = createLogger({ service: "imap-poller" })

const MAX_BACKOFF_MS = 15 * 60 * 1000
const MAX_EMAILS_PER_POLL = 50
const FIRST_SYNC_DAYS = 7

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

      const encoder = new TextEncoder()
      const writer = (imap as any).writer as WritableStreamDefaultWriter
      const reader = (imap as any).reader as ReadableStreamDefaultReader

      // UID-based search instead of SEARCH UNSEEN — catches emails
      // regardless of \Seen flag (fixes Feishu and similar IMAP servers
      // that auto-mark emails as read).
      const lastUid = parseInt(account.lastSyncedUid, 10) || 0
      let searchCmd: string
      if (lastUid > 0) {
        searchCmd = `UID SEARCH UID ${lastUid + 1}:*`
      } else {
        const since = new Date()
        since.setDate(since.getDate() - FIRST_SYNC_DAYS)
        const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
        searchCmd = `UID SEARCH SINCE ${since.getDate()}-${months[since.getMonth()]}-${since.getFullYear()}`
      }

      const searchResp = await this.imapReadUntilTag(writer, reader, encoder, "S1", searchCmd)
      const searchLine = searchResp.split("\r\n").find(l => l.startsWith("* SEARCH"))
      const uids: number[] = searchLine
        ? searchLine.replace("* SEARCH", "").trim().split(/\s+/).map(Number).filter(n => !isNaN(n) && n > lastUid)
        : []

      pollLog.info("uid search complete", { found: uids.length, lastUid })

      if (uids.length === 0) {
        await queries.emailAccount.updateEmailAccount(db, accountId, account.workspaceId, {
          lastSyncedAt: new Date().toISOString(),
          status: "active",
          errorMessage: "",
        })
        await this.scheduleNext(account.pollIntervalSeconds * 1000)
        await imap.logout()
        return
      }

      const sorted = uids.sort((a, b) => a - b)
      const batch = sorted.slice(0, MAX_EMAILS_PER_POLL)

      let maxUid = lastUid
      for (const uid of batch) {
        const tag = `F${uid}`
        const fetchResp = await this.imapReadUntilTag(writer, reader, encoder, tag, `UID FETCH ${uid} (BODY.PEEK[])`)

        const rawEmail = this.extractEmailFromFetch(fetchResp)
        if (!rawEmail) {
          pollLog.warn("failed to extract email content", { uid })
          maxUid = Math.max(maxUid, uid)
          continue
        }

        const parsed = await PostalMime.parse(rawEmail)

        const r2Id = nanoid()
        const r2Key = `emails/${r2Id}/raw`
        await this.env.EMAIL_BUCKET.put(r2Key, rawEmail, {
          httpMetadata: { contentType: "message/rfc822" },
        })

        const fromAddr = parsed.from?.address || parsed.from?.name || ""
        const isWhitelisted = await queries.whitelist.isWhitelisted(
          db, account.agentId, account.workspaceId, fromAddr
        )

        await this.notifyWeb({
          agentId: account.agentId,
          workspaceId: account.workspaceId,
          r2Key,
          from: fromAddr,
          to: account.emailAddress,
          subject: parsed.subject || "",
          isWhitelisted,
          messageId: parsed.messageId || "",
          inReplyTo: parsed.inReplyTo || "",
          references: parsed.references || "",
        })

        maxUid = Math.max(maxUid, uid)
      }

      await queries.emailAccount.updateEmailAccount(db, accountId, account.workspaceId, {
        lastSyncedAt: new Date().toISOString(),
        lastSyncedUid: String(maxUid),
        status: "active",
        errorMessage: "",
      })

      pollLog.info("poll complete", { processed: batch.length, maxUid })

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

  private async imapReadUntilTag(
    writer: WritableStreamDefaultWriter,
    reader: ReadableStreamDefaultReader,
    encoder: TextEncoder,
    tag: string,
    cmd: string,
  ): Promise<string> {
    await writer.write(encoder.encode(`${tag} ${cmd}\r\n`))
    const decoder = new TextDecoder()
    let buf = ""
    const READ_TIMEOUT_MS = 15_000
    while (true) {
      const { value, done } = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`IMAP read timeout for ${tag}`)), READ_TIMEOUT_MS)
        ),
      ])
      if (done) break
      buf += decoder.decode(value, { stream: true })
      for (const line of buf.split("\r\n")) {
        if (line.startsWith(`${tag} OK`) || line.startsWith(`${tag} NO`) || line.startsWith(`${tag} BAD`)) {
          if (line.startsWith(`${tag} NO`) || line.startsWith(`${tag} BAD`)) {
            throw new Error(`IMAP ${tag} failed: ${line}`)
          }
          return buf
        }
      }
    }
    throw new Error(`IMAP stream ended without tagged response for ${tag}`)
  }

  private extractEmailFromFetch(response: string): string | null {
    const literalMatch = response.match(/\{(\d+)\}\r\n/)
    if (!literalMatch) return null

    const contentStart = response.indexOf(literalMatch[0]) + literalMatch[0].length
    const closingIdx = response.lastIndexOf("\r\n)")
    if (closingIdx > contentStart) {
      return response.substring(contentStart, closingIdx)
    }
    return null
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
