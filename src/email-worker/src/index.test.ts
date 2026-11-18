import { describe, it, expect, vi } from "vitest"
vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }))
import handler from "./index"

describe("POST /send/otp", () => {
  function makeOtpRequest(body: Record<string, unknown>) {
    return new Request("http://localhost/send/otp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  }

  function otpEnv() {
    const send = vi.fn().mockResolvedValue({ messageId: "mock-msg-id" })
    const sendEmail = { send } as unknown as SendEmail
    return {
      env: { SEND_EMAIL: sendEmail },
      send,
    }
  }

  it("sends OTP email via SEND_EMAIL binding", async () => {
    const { env, send } = otpEnv()
    const res = await handler.fetch(
      makeOtpRequest({ to: "user@example.com", subject: "Your code", html: "<p>123456</p>" }),
      env,
    )

    expect(res.status).toBe(200)
    const json = await res.json() as { ok: boolean }
    expect(json.ok).toBe(true)
    expect(send).toHaveBeenCalledOnce()
    expect(send).toHaveBeenCalledWith({
      from: "no-reply@alook.ai",
      to: "user@example.com",
      subject: "Your code",
      html: "<p>123456</p>",
    })
  })

  it("returns 400 when 'to' is missing", async () => {
    const { env } = otpEnv()
    const res = await handler.fetch(
      makeOtpRequest({ subject: "code", html: "<p>x</p>" }),
      env,
    )
    expect(res.status).toBe(400)
  })

  it("returns 400 when 'subject' is missing", async () => {
    const { env } = otpEnv()
    const res = await handler.fetch(
      makeOtpRequest({ to: "user@example.com", html: "<p>x</p>" }),
      env,
    )
    expect(res.status).toBe(400)
  })
})


it("propagates an OTP send failure instead of claiming success", async () => {
  const send = vi.fn().mockRejectedValue(new Error("mail unavailable"))
  await expect(handler.fetch(new Request("https://worker.test/send/otp", {
    method: "POST", body: JSON.stringify({ to: "owner@example.test", subject: "Code" }),
  }), { SEND_EMAIL: { send } } as unknown as Parameters<typeof handler.fetch>[1])).rejects.toThrow("mail unavailable")
})

it.each(["/send/agent", "/imap/start?accountId=old", "/imap/sync?accountId=old"])("retired endpoint %s cannot invoke bindings", async (path) => {
  const env = new Proxy({}, { get() { throw new Error("retired binding accessed") } })
  const result = await handler.fetch(new Request(`https://worker.test${path}`, { method: "POST" }), env as Parameters<typeof handler.fetch>[1])
  expect(result.status).toBe(404)
})

it("rejects retired inbound agent mail without reading or archiving it", async () => {
  const setReject = vi.fn()
  handler.email({ setReject } as unknown as ForwardableEmailMessage)
  expect(setReject).toHaveBeenCalledWith("Agent email has been retired")
})
