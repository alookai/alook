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

  email(message: ForwardableEmailMessage): void {
    message.setReject("Agent email has been retired")
  },
}
