import { vi } from "vitest"

// --- R2 Mock ---

export function createMockR2() {
  const put = vi.fn().mockResolvedValue(undefined)
  return { bucket: { put } as unknown as R2Bucket, put }
}

// --- Fetcher Mock (WEB_SERVICE) ---

export function createMockFetcher() {
  const fetch = vi.fn().mockResolvedValue(new Response("ok"))
  return { fetcher: { fetch } as unknown as Fetcher, fetch }
}

// --- SendEmail Mock ---

export function createMockSendEmail() {
  const send = vi.fn().mockResolvedValue({ messageId: "mock-msg-id" })
  return { sendEmail: { send } as unknown as SendEmail, send }
}

// --- ForwardableEmailMessage Mock ---

export interface MockMessageOpts {
  from: string
  to: string
  subject?: string | null
  body?: string
}

export function createMockMessage(opts: MockMessageOpts) {
  const headers = new Headers()
  if (opts.subject !== undefined && opts.subject !== null) {
    headers.set("subject", opts.subject)
  }

  const rawText = [
    `From: ${opts.from}`,
    `To: ${opts.to}`,
    `Subject: ${opts.subject ?? ""}`,
    "",
    opts.body ?? "",
  ].join("\r\n")

  const setReject = vi.fn()
  const forward = vi.fn().mockResolvedValue(undefined)
  const reply = vi.fn().mockResolvedValue(undefined)

  return {
    message: {
      from: opts.from,
      to: opts.to,
      headers,
      raw: new Response(rawText).body!,
      rawSize: rawText.length,
      setReject,
      forward,
      reply,
    } as unknown as ForwardableEmailMessage,
    setReject,
    forward,
    rawText,
  }
}
