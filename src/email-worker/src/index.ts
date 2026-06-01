import { nanoid } from "nanoid"
import PostalMime from "postal-mime"
import { createDb, queries, parseEmailHandle, toAlookAddress, DEV_WEB_URL, createLogger, buildMimeMessage, extractAttachmentMeta } from "@alook/shared"
import { decrypt } from "@alook/shared/crypto"
import { WorkerMailer, type AuthType } from "worker-mailer"
import { EmailMessage } from "cloudflare:email"

const SMTP_AUTH_TYPES: AuthType[] = ["plain", "login", "cram-md5"]
import type { EmailEnv } from "./types"

export { ImapPollerDO } from "./imap-poller-do"

const log = createLogger({ service: "email" })

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ""
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]!)
  }
  return btoa(binary)
}

async function notifyWeb(env: EmailEnv, payload: Record<string, unknown>, traceId: string) {
  const body = JSON.stringify(payload)
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Trace-Id": traceId,
  }

  const init: RequestInit = { method: "POST", headers, body }

  try {
    const res = await env.WEB_SERVICE.fetch("http://internal/api/email/notify", init)
    if (!res.ok) {
      const errBody = await res.text().catch(() => "")
      throw new Error(`WEB_SERVICE responded ${res.status}: ${errBody}`)
    }
  } catch (serviceErr) {
    try {
      const fallback = await fetch(`${DEV_WEB_URL}/api/email/notify`, init)
      if (!fallback.ok) throw new Error(`fallback responded ${fallback.status}`)
    } catch {
      throw serviceErr instanceof Error ? serviceErr : new Error(String(serviceErr))
    }
  }
}

export default {
  async fetch(request: Request, env: EmailEnv): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === "/health" && request.method === "GET") {
      return Response.json({ status: "ok" })
    }

    if (url.pathname.startsWith("/imap/")) {
      return this.handleImap(request, env, url)
    }

    if (request.method !== "POST") {
      return Response.json({ error: "method not allowed" }, { status: 405 })
    }

    if (url.pathname === "/send/otp") {
      return this.handleSendOtp(request, env)
    }

    if (url.pathname === "/send/agent") {
      return this.handleSendAgent(request, env)
    }

    return Response.json({ error: "not found" }, { status: 404 })
  },

  async handleSendOtp(request: Request, env: EmailEnv): Promise<Response> {
    const body = await request.json() as { to?: string; subject?: string; html?: string }

    if (!body.to || !body.subject) {
      return Response.json({ error: "to and subject are required" }, { status: 400 })
    }

    await env.SEND_EMAIL.send({
      from: toAlookAddress("no-reply"),
      to: body.to,
      subject: body.subject,
      html: body.html ?? "",
    })

    return Response.json({ ok: true })
  },

  async handleSendAgent(request: Request, env: EmailEnv): Promise<Response> {
    const body = await request.json() as {
      agentId?: string
      workspaceId?: string
      to?: string
      subject?: string
      htmlBody?: string
      inReplyTo?: string
      references?: string
      attachmentKeys?: { key: string; filename: string; contentType: string }[]
      customAccountId?: string
    }

    if (!body.agentId || !body.workspaceId || !body.to || !body.subject) {
      return Response.json({ error: "agentId, workspaceId, to, and subject are required" }, { status: 400 })
    }

    const db = createDb(env.DB)
    const agent = await queries.agent.getAgent(db, body.agentId, body.workspaceId)
    if (!agent) {
      return Response.json({ error: "agent not found in workspace" }, { status: 404 })
    }

    let fromAddress: string
    let useCustomSmtp = false
    let customAccount: Awaited<ReturnType<typeof queries.emailAccount.getEmailAccount>> | null = null

    if (body.customAccountId) {
      customAccount = await queries.emailAccount.getEmailAccount(db, body.customAccountId, body.workspaceId)
      if (!customAccount) {
        return Response.json({ error: "custom email account not found" }, { status: 404 })
      }
      fromAddress = customAccount.displayName
        ? `${customAccount.displayName} <${customAccount.emailAddress}>`
        : customAccount.emailAddress
      useCustomSmtp = true
    } else {
      if (!agent.emailHandle) {
        return Response.json({ error: "agent has no email handle configured" }, { status: 400 })
      }
      fromAddress = toAlookAddress(agent.emailHandle)
    }

    const htmlBody = body.htmlBody ?? ""
    const attachmentKeys = body.attachmentKeys ?? []

    // Fetch attachment content from R2 in parallel
    const attachments = (await Promise.all(
      attachmentKeys.map(async (att) => {
        const obj = await env.EMAIL_BUCKET.get(att.key)
        if (!obj) return null
        const raw = await obj.arrayBuffer()
        return {
          disposition: "attachment" as const,
          filename: att.filename,
          type: att.contentType,
          raw,
          base64: arrayBufferToBase64(raw),
        }
      })
    )).filter((a): a is NonNullable<typeof a> => a !== null)

    // Generate the outbound Message-ID ONCE, before sending. This same id is placed
    // on the wire, returned to the caller (for conversation-map registration), and
    // stored in the R2 archive — so a human's reply (In-Reply-To = this id) threads
    // back into the originating conversation. The id's domain must match the sending
    // domain: @alook.ai for the CF path, the custom-account domain for the SMTP path.
    const fromDomain = useCustomSmtp && customAccount
      ? customAccount.emailAddress.split("@").pop()
      : "alook.ai"
    const outMessageId = `<${nanoid()}@${fromDomain}>`

    // Build the raw MIME once — used both as the wire message (CF path) and as the
    // R2 archive (both paths). buildMimeMessage emits From + Message-ID + threading
    // headers, so the archived copy always matches what was transmitted.
    const rawMime = buildMimeMessage({
      from: fromAddress,
      to: body.to,
      subject: body.subject,
      messageId: outMessageId,
      inReplyTo: body.inReplyTo,
      references: body.references,
      body: htmlBody,
      bodyType: "text/html",
      attachments: attachments.map(a => ({ filename: a.filename, contentType: a.type, base64: a.base64 })),
    })

    if (useCustomSmtp && customAccount) {
      const secret = env.ENCRYPTION_KEY
      if (!secret) {
        return Response.json({ error: "encryption key not configured" }, { status: 500 })
      }
      try {
        const smtpUsername = decrypt(customAccount.smtpUsername, secret)
        const smtpPassword = decrypt(customAccount.smtpPassword, secret)
        const smtpTls = customAccount.smtpTls as number

        // Control the wire Message-ID so it equals the registered/archived id.
        // WorkerMailer respects a provided Message-ID and only auto-generates if absent.
        const threadingHeaders: Record<string, string> = { "Message-ID": outMessageId }
        if (body.inReplyTo) threadingHeaders["In-Reply-To"] = body.inReplyTo
        if (body.references) threadingHeaders["References"] = body.references

        await WorkerMailer.send(
          {
            host: customAccount.smtpHost,
            port: customAccount.smtpPort,
            secure: smtpTls === 2,
            startTls: smtpTls === 1,
            authType: SMTP_AUTH_TYPES,
            credentials: { username: smtpUsername, password: smtpPassword },
          },
          {
            from: customAccount.displayName
              ? { name: customAccount.displayName, email: customAccount.emailAddress }
              : customAccount.emailAddress,
            to: body.to,
            subject: body.subject,
            html: htmlBody,
            headers: threadingHeaders,
            attachments: attachments.map(a => ({
              filename: a.filename,
              content: a.base64,
              mimeType: a.type,
            })),
          }
        )
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        log.error("custom SMTP send failed", { error: msg, accountId: body.customAccountId })
        return Response.json({ error: `SMTP send failed: ${msg}` }, { status: 500 })
      }
    } else {
      // Send the raw MIME so the wire Message-ID (and threading headers) are the ones
      // we control. The CF structured builder has no reliable Message-ID field — its
      // MTA assigns its own — so we use the raw-MIME overload instead.
      await env.SEND_EMAIL.send(new EmailMessage(fromAddress, body.to, rawMime))
    }

    // Store the SAME MIME archive in R2 (wire id == archived id).
    const r2Id = nanoid()
    const r2Key = `emails/${r2Id}/raw`
    await env.EMAIL_BUCKET.put(r2Key, rawMime, {
      httpMetadata: { contentType: "message/rfc822" },
    })

    return Response.json({ ok: true, r2Key, messageId: outMessageId })
  },

  async handleImap(request: Request, env: EmailEnv, url: URL): Promise<Response> {
    const accountId = url.searchParams.get("accountId")
    if (!accountId) {
      return Response.json({ error: "accountId query parameter required" }, { status: 400 })
    }

    const doId = env.IMAP_POLLER.idFromName(accountId)
    const stub = env.IMAP_POLLER.get(doId)

    const action = url.pathname.replace("/imap/", "")

    if (action === "start" && request.method === "POST") {
      return stub.fetch(new Request("http://internal/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId }),
      }))
    }

    if (action === "stop" && request.method === "POST") {
      return stub.fetch(new Request("http://internal/stop", { method: "POST" }))
    }

    if (action === "sync" && request.method === "POST") {
      return stub.fetch(new Request("http://internal/sync", { method: "POST" }))
    }

    if (action === "status" && request.method === "GET") {
      return stub.fetch(new Request("http://internal/status", { method: "GET" }))
    }

    if (action === "test" && request.method === "POST") {
      const workspaceId = url.searchParams.get("workspaceId") ?? undefined
      return this.handleTestConnection(accountId, env, workspaceId)
    }

    return Response.json({ error: "not found" }, { status: 404 })
  },

  async handleTestConnection(accountId: string, env: EmailEnv, workspaceId?: string): Promise<Response> {
    const db = createDb(env.DB)
    const account = await queries.emailAccount.getEmailAccountById(db, accountId, workspaceId)
    if (!account) {
      return Response.json({ error: "account not found" }, { status: 404 })
    }

    const secret = env.ENCRYPTION_KEY
    if (!secret) {
      return Response.json({ error: "encryption key not configured" }, { status: 500 })
    }

    const result: { imap: string; smtp: string } = { imap: "untested", smtp: "untested" }

    try {
      const { ImapClient } = await import("./lib/imap-client")
      const imapClient = new ImapClient({
        host: account.imapHost,
        port: account.imapPort,
        tls: account.imapTls as unknown as boolean,
        auth: {
          username: decrypt(account.imapUsername, secret),
          password: decrypt(account.imapPassword, secret),
        },
      })
      await imapClient.connect()
      await imapClient.logout()
      result.imap = "ok"
    } catch (err: unknown) {
      result.imap = `error: ${err instanceof Error ? err.message : String(err)}`
    }

    try {
      const smtpUsername = decrypt(account.smtpUsername, secret)
      const smtpPassword = decrypt(account.smtpPassword, secret)
      const smtpTls = account.smtpTls as number
      const mailer = await WorkerMailer.connect({
        host: account.smtpHost,
        port: account.smtpPort,
        secure: smtpTls === 2,
        startTls: smtpTls === 1,
        authType: SMTP_AUTH_TYPES,
        credentials: { username: smtpUsername, password: smtpPassword },
      })
      await mailer.close()
      result.smtp = "ok"
    } catch (err: unknown) {
      result.smtp = `error: ${err instanceof Error ? err.message : String(err)}`
    }

    const allOk = result.imap === "ok" && result.smtp === "ok"
    return Response.json(result, { status: allOk ? 200 : 422 })
  },

  async email(message: ForwardableEmailMessage, env: EmailEnv): Promise<void> {
    const traceId = nanoid(12)
    const emailLog = log.child({ traceId, from: message.from, to: message.to })

    const db = createDb(env.DB)
    const handle = parseEmailHandle(message.to)

    const agent = await queries.agent.getAgentByHandle(db, handle)
    if (!agent) {
      emailLog.warn("no agent found", { handle })
      message.setReject("No agent found for this address")
      return
    }

    emailLog.info("email received", { agentId: agent.id, handle })

    const whitelisted = await queries.whitelist.isWhitelisted(db, agent.id, agent.workspaceId, message.from)

    const rawBytes = await new Response(message.raw).arrayBuffer()
    const r2Id = nanoid()
    const r2Key = `emails/${r2Id}/raw`
    await env.EMAIL_BUCKET.put(r2Key, rawBytes, {
      httpMetadata: { contentType: "message/rfc822" },
    })

    const parsed = await PostalMime.parse(rawBytes)
    const attachmentsMeta = extractAttachmentMeta(parsed.attachments || [])

    const subject = parsed.subject || message.headers.get("subject") || "(No Subject)"
    const messageId = message.headers.get("message-id") ?? ""
    const inReplyTo = message.headers.get("in-reply-to") ?? ""
    const references = message.headers.get("references") ?? ""

    const threadingFields = { messageId, inReplyTo, references }
    const attachmentsField = attachmentsMeta.length > 0 ? { attachments: JSON.stringify(attachmentsMeta) } : {}

    if (whitelisted) {
      emailLog.info("whitelisted email, notifying web", { agentId: agent.id })
      await notifyWeb(env, {
        agentId: agent.id,
        workspaceId: agent.workspaceId,
        r2Key,
        from: message.from,
        to: message.to,
        subject,
        isWhitelisted: true,
        ...threadingFields,
        ...attachmentsField,
      }, traceId)
    } else {
      emailLog.info("non-whitelisted email, rejecting", { agentId: agent.id })
      await notifyWeb(env, {
        agentId: agent.id,
        workspaceId: agent.workspaceId,
        r2Key,
        from: message.from,
        to: message.to,
        subject,
        isWhitelisted: false,
        forwarded: false,
        ...threadingFields,
        ...attachmentsField,
      }, traceId)

      message.setReject("Sender not whitelisted")
    }
  },
}
