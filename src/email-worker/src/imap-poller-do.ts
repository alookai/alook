import { DurableObject } from "cloudflare:workers"
import PostalMime from "postal-mime"
import { nanoid } from "nanoid"
import { createDb, queries, createLogger, parseIcs, extractAttachmentMeta } from "@alook/shared"
import type { MeetingInfo } from "@alook/shared"
import { decrypt } from "@alook/shared/crypto"
import { ImapClient, ImapAuthError } from "./lib/imap-client"
import type { EmailEnv } from "./types"

const log = createLogger({ service: "imap-poller" })

const MAX_BACKOFF_MS = 15 * 60 * 1000
const DEFAULT_POLL_MS = 60_000
const MAX_EMAILS_PER_POLL = 50
const FIRST_SYNC_DAYS = 7
const POLL_TIMEOUT_MS = 25_000

export class ImapPollerDO extends DurableObject<EmailEnv> {
  private accountId: string | null = null
  private _db: ReturnType<typeof createDb> | null = null

  private get db() {
    return (this._db ??= createDb(this.env.DB))
  }

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
      const db = this.db
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
    const accountId = this.accountId ?? await this.ctx.storage.get<string>("accountId")
    if (!accountId) return

    let pollIntervalMs = DEFAULT_POLL_MS
    try {
      const db = this.db
      const account = await queries.emailAccount.getEmailAccountById(db, accountId)
      if (!account) {
        await this.ctx.storage.deleteAlarm()
        await this.ctx.storage.deleteAll()
        return
      }
      pollIntervalMs = account.pollIntervalSeconds * 1000
    } catch {
      // DB read failed — use default interval, will retry next alarm
    }

    try {
      await Promise.race([
        this.pollImap(),
        new Promise<void>((_, reject) => setTimeout(() => reject(new Error("poll timeout")), POLL_TIMEOUT_MS)),
      ])
    } catch (e) {
      log.warn("alarm: poll aborted", { err: String(e) })
    } finally {
      // Always ensure next alarm is scheduled so the chain never breaks
      const existing = await this.ctx.storage.getAlarm()
      if (!existing) {
        const backoff = (await this.ctx.storage.get<number>("backoffMs")) ?? 0
        await this.scheduleNext(backoff || pollIntervalMs)
      }
    }
  }

  private async pollImap(): Promise<void> {
    const accountId = this.accountId ?? await this.ctx.storage.get<string>("accountId")
    if (!accountId) return

    const db = this.db
    const account = await queries.emailAccount.getEmailAccountById(db, accountId)
    if (!account) {
      await this.ctx.storage.deleteAlarm()
      await this.ctx.storage.deleteAll()
      return
    }

    const pollLog = log.child({ accountId, agentId: account.agentId })
    let client: ImapClient | null = null

    try {
      const secret = this.env.ENCRYPTION_KEY
      if (!secret) throw new Error("ENCRYPTION_KEY not configured")

      const imapUsername = decrypt(account.imapUsername, secret)
      const imapPassword = decrypt(account.imapPassword, secret)

      client = new ImapClient({
        host: account.imapHost,
        port: account.imapPort,
        tls: account.imapTls as unknown as boolean,
        auth: { username: imapUsername, password: imapPassword },
      })

      await client.connect()
      await client.select("INBOX")

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

      const searchResp = await client.command("S1", searchCmd)
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
        await client.logout()
        return
      }

      const sorted = uids.sort((a, b) => a - b)
      const batch = sorted.slice(0, MAX_EMAILS_PER_POLL)

      const whitelist = await queries.whitelist.buildWhitelistSet(
        db, account.agentId, account.workspaceId
      )

      let maxUid = lastUid
      for (const uid of batch) {
        const tag = `F${uid}`
        const fetchResp = await client.command(tag, `UID FETCH ${uid} (BODY.PEEK[])`)

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
        const isWhitelisted = whitelist.check(fromAddr)

        let meetingInfo: MeetingInfo | null = null
        const icsAttachment = parsed.attachments?.find(
          att => att.mimeType?.includes("text/calendar") || att.filename?.endsWith(".ics")
        )
        if (icsAttachment) {
          try {
            const icsText = typeof icsAttachment.content === "string"
              ? icsAttachment.content
              : new TextDecoder().decode(icsAttachment.content)
            const info = parseIcs(icsText)
            if (info.meetingUrl) meetingInfo = info
          } catch {
            pollLog.warn("failed to parse ICS attachment", { uid })
          }
        }

        const attachmentsMeta = extractAttachmentMeta(parsed.attachments || [])

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
          meetingInfo,
          ...(attachmentsMeta.length > 0 ? { attachments: JSON.stringify(attachmentsMeta) } : {}),
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
      await client.logout()
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      pollLog.error("poll failed", { error: msg })

      await queries.emailAccount.updateEmailAccount(db, accountId, account.workspaceId, {
        status: "error",
        errorMessage: msg.slice(0, 500),
      })

      if (err instanceof ImapAuthError) {
        pollLog.warn("auth error — will retry with backoff", { permanent: err.permanent })
      }

      const currentBackoff = (await this.ctx.storage.get<number>("backoffMs")) ?? 0
      const nextBackoff = Math.min(
        currentBackoff === 0 ? account.pollIntervalSeconds * 1000 : currentBackoff * 2,
        MAX_BACKOFF_MS
      )
      await this.ctx.storage.put("backoffMs", nextBackoff)
      await this.scheduleNext(nextBackoff)

      try { await client?.logout() } catch { /* ignore */ }
    }
  }

  private extractEmailFromFetch(response: string): string | null {
    const literalMatch = response.match(/\{(\d+)\}\r\n/)
    if (!literalMatch) return null

    const literalLen = parseInt(literalMatch[1]!, 10)
    const contentStart = response.indexOf(literalMatch[0]) + literalMatch[0].length
    if (contentStart + literalLen <= response.length) {
      return response.substring(contentStart, contentStart + literalLen)
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
