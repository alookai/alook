import { toAlookAddress } from "@alook/shared"
import type { EmailEnv } from "./types"

export { ImapPollerDO } from "./imap-poller-do"

export default {
  async fetch(request: Request, env: EmailEnv): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === "/health" && request.method === "GET") {
      return Response.json({ status: "ok" })
    }
    if (request.method !== "POST") {
      return Response.json({ error: "method not allowed" }, { status: 405 })
    }
    if (url.pathname === "/send/otp") {
      return this.handleSendOtp(request, env)
    }
    return Response.json({ error: "not found" }, { status: 404 })
  },

  async handleSendOtp(request: Request, env: EmailEnv): Promise<Response> {
    let raw: unknown
    try {
      raw = await request.json()
    } catch {
      return Response.json({ error: "invalid json body" }, { status: 400 })
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return Response.json({ error: "invalid json body" }, { status: 400 })
    }
    const body = raw as Record<string, unknown>
    const to = typeof body.to === "string" ? body.to.trim() : ""
    const subject = typeof body.subject === "string" ? body.subject.trim() : ""
    if (!to || !subject) {
      return Response.json({ error: "to and subject are required" }, { status: 400 })
    }
    if (body.html !== undefined && typeof body.html !== "string") {
      return Response.json({ error: "html must be a string" }, { status: 400 })
    }
    await env.SEND_EMAIL.send({
      from: toAlookAddress("no-reply"),
      to,
      subject,
      html: body.html ?? "",
    })
    return Response.json({ ok: true })
  },

  email(message: ForwardableEmailMessage): void {
    message.setReject("Agent email has been retired")
  },
}
