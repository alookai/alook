import { nanoid } from "nanoid"
import { createDb, queries, parseEmailHandle, DEV_WEB_URL, createLogger } from "@alook/shared"

const log = createLogger({ service: "email" })

interface EmailEnv {
  DB: D1Database
  EMAIL_BUCKET: R2Bucket
  WEB_SERVICE: Fetcher
  SEND_EMAIL: SendEmail
}

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

  try {
    const res = await env.WEB_SERVICE.fetch("http://internal/api/email/notify", {
      method: "POST",
      headers,
      body,
    })
    if (!res.ok) throw new Error(`WEB_SERVICE responded ${res.status}`)
  } catch (err) {
    log.warn("WEB_SERVICE notify failed, falling back to DEV_WEB_URL", { err })
    await fetch(`${DEV_WEB_URL}/api/email/notify`, {
      method: "POST",
      headers,
      body,
    })
  }
}

export default {
  async fetch(request: Request, env: EmailEnv): Promise<Response> {
    const url = new URL(request.url)

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
      from: "no-reply@alook.ai",
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
      attachmentKeys?: { key: string; filename: string; contentType: string }[]
    }

    if (!body.agentId || !body.workspaceId || !body.to || !body.subject) {
      return Response.json({ error: "agentId, workspaceId, to, and subject are required" }, { status: 400 })
    }

    const db = createDb(env.DB)
    const agent = await queries.agent.getAgent(db, body.agentId, body.workspaceId)
    if (!agent) {
      return Response.json({ error: "agent not found in workspace" }, { status: 404 })
    }

    if (!agent.emailHandle) {
      return Response.json({ error: "agent has no email handle configured" }, { status: 400 })
    }

    const fromAddress = `${agent.emailHandle}@alook.ai`
    const htmlBody = body.htmlBody ?? ""
    const attachmentKeys = body.attachmentKeys ?? []

    // Fetch attachment content from R2 and convert to base64
    const attachments: { disposition: "attachment"; filename: string; type: string; content: string }[] = []
    for (const att of attachmentKeys) {
      const obj = await env.EMAIL_BUCKET.get(att.key)
      if (!obj) continue
      const buf = await obj.arrayBuffer()
      attachments.push({
        disposition: "attachment" as const,
        filename: att.filename,
        type: att.contentType,
        content: arrayBufferToBase64(buf),
      })
    }

    // Send via CF builder overload (content as base64 string per CF docs)
    const sendPayload: Record<string, unknown> = {
      from: fromAddress,
      to: body.to,
      subject: body.subject,
      html: htmlBody,
    }
    if (attachments.length > 0) {
      sendPayload.attachments = attachments
    }
    await env.SEND_EMAIL.send(sendPayload as any)

    // Build raw MIME for R2 archival
    let rawMime: string
    if (attachments.length === 0) {
      rawMime = [
        `From: ${fromAddress}`,
        `To: ${body.to}`,
        `Subject: ${body.subject}`,
        `Date: ${new Date().toUTCString()}`,
        `MIME-Version: 1.0`,
        `Content-Type: text/html; charset=utf-8`,
        "",
        htmlBody,
      ].join("\r\n")
    } else {
      const boundary = `----=_Part_${nanoid(16)}`
      const parts = [
        `From: ${fromAddress}`,
        `To: ${body.to}`,
        `Subject: ${body.subject}`,
        `Date: ${new Date().toUTCString()}`,
        `MIME-Version: 1.0`,
        `Content-Type: multipart/mixed; boundary="${boundary}"`,
        "",
        `--${boundary}`,
        `Content-Type: text/html; charset=utf-8`,
        `Content-Transfer-Encoding: 7bit`,
        "",
        htmlBody,
      ]
      for (const att of attachments) {
        parts.push(
          [
            `--${boundary}`,
            `Content-Type: ${att.type}; name="${att.filename}"`,
            `Content-Disposition: attachment; filename="${att.filename}"`,
            `Content-Transfer-Encoding: base64`,
            "",
            att.content.match(/.{1,76}/g)?.join("\r\n") ?? att.content,
          ].join("\r\n")
        )
      }
      parts.push(`--${boundary}--`)
      rawMime = parts.join("\r\n")
    }

    // Store MIME archive in R2
    const r2Id = nanoid()
    const r2Key = `emails/${r2Id}/raw`
    await env.EMAIL_BUCKET.put(r2Key, rawMime, {
      httpMetadata: { contentType: "message/rfc822" },
    })

    return Response.json({ ok: true, r2Key })
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

    const subject = message.headers.get("subject") ?? ""

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
      }, traceId)
    } else {
      const forwardToEmail = agent.forwardToEmail ?? ""
      let forwardAddress = forwardToEmail

      if (!forwardAddress) {
        const agentUser = agent.ownerId ? await queries.user.getUser(db, agent.ownerId) : null
        forwardAddress = agentUser?.email ?? ""
      }

      const forwarded = !!forwardAddress

      emailLog.info("non-whitelisted email, notifying web", { agentId: agent.id, forwarded })
      await notifyWeb(env, {
        agentId: agent.id,
        workspaceId: agent.workspaceId,
        r2Key,
        from: message.from,
        to: message.to,
        subject,
        isWhitelisted: false,
        forwarded,
      }, traceId)

      if (forwardAddress) {
        emailLog.info("forwarding email", { forwardTo: forwardAddress })
        await message.forward(forwardAddress)
      }
    }
  },
}
