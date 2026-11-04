import { vi } from "vitest"

// --- cloudflare:sockets Mock ---

export interface MockSocket {
  /** The fake Socket to hand back from `connect()` / `startTls()`. */
  socket: Socket
  /** Push a raw server response chunk into the readable stream (caller usually appends \r\n). */
  pushData: (data: string | Uint8Array) => void
  /** Signal end-of-stream so a pending read resolves `{ done: true }`. */
  close: () => void
  /** All payloads written by the client, decoded to strings. */
  writes: string[]
  /** Spy on socket.close(). */
  onClose: ReturnType<typeof vi.fn>
  /** Spy on socket.startTls() (returns the same socket). */
  onStartTls: ReturnType<typeof vi.fn>
}

/**
 * Build a controllable fake `Socket` for testing code that talks IMAP/SMTP over
 * `cloudflare:sockets`. The readable side is driven by `pushData()`/`close()`;
 * the writable side records every chunk into `writes`.
 *
 * Usage:
 *   const m = createMockSocket()
 *   vi.mock("cloudflare:sockets", () => ({ connect: vi.fn(() => m.socket) }))
 *   m.pushData("* OK greeting\r\n")
 */
export function createMockSocket(): MockSocket {
  const decoder = new TextDecoder()
  const writes: string[] = []
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null
  // Buffer data pushed before the consumer attaches a reader/controller.
  const pending: Uint8Array[] = []
  let closed = false

  const readable = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c
      for (const chunk of pending) c.enqueue(chunk)
      pending.length = 0
      if (closed) c.close()
    },
  })

  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      writes.push(decoder.decode(chunk))
    },
  })

  const pushData = (data: string | Uint8Array) => {
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data
    if (controller) controller.enqueue(bytes)
    else pending.push(bytes)
  }

  const close = () => {
    closed = true
    try { controller?.close() } catch { /* already closed */ }
  }

  const onClose = vi.fn(async () => {})
  const onStartTls = vi.fn(() => socket)

  const socket = {
    readable,
    writable,
    close: onClose,
    startTls: onStartTls,
  } as unknown as Socket

  return { socket, pushData, close, writes, onClose, onStartTls }
}

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
  extraHeaders?: Record<string, string>
}

export const CALENDAR_CONTENT = [
  "BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VTIMEZONE", "TZID:Office", "BEGIN:STANDARD",
  "DTSTART:20000101T000000", "TZOFFSETFROM:+0100", "TZOFFSETTO:+0100", "END:STANDARD", "END:VTIMEZONE",
  "BEGIN:VEVENT", "SUMMARY:日程🙂", "DTSTART;TZID=Office:20261101T100000", "DTEND;TZID=Office:20261101T110000",
  "LOCATION:https://meet.google.com/abc-defg-hij", "ATTENDEE;CN=Guest:mailto:guest@example.test",
  "END:VEVENT", "END:VCALENDAR", "",
].join("\n")
export const CALENDAR_MESSAGE = {
  body: CALENDAR_CONTENT.replace(/\n/g, "\r\n"),
  extraHeaders: {
    "MIME-Version": "1.0",
    "Content-Type": "text/calendar; charset=utf-8",
    "Content-Disposition": "attachment; filename=invite.ics",
    "Content-Transfer-Encoding": "8bit",
  },
}

export function buildRawMessage(opts: MockMessageOpts): string {
  return [
    `From: ${opts.from}`,
    `To: ${opts.to}`,
    `Subject: ${opts.subject ?? ""}`,
    ...Object.entries(opts.extraHeaders ?? {}).map(([key, value]) => `${key}: ${value}`),
    "",
    opts.body ?? "",
  ].join("\r\n")
}

export function createMockMessage(opts: MockMessageOpts) {
  const headers = new Headers()
  if (opts.subject !== undefined && opts.subject !== null) {
    headers.set("subject", opts.subject)
  }
  if (opts.extraHeaders) {
    for (const [k, v] of Object.entries(opts.extraHeaders)) {
      headers.set(k, v)
    }
  }

  const rawText = buildRawMessage(opts)

  const setReject = vi.fn()
  const forward = vi.fn().mockResolvedValue(undefined)
  const reply = vi.fn().mockResolvedValue(undefined)

  return {
    message: {
      from: opts.from,
      to: opts.to,
      headers,
      raw: new Response(rawText).body!,
      rawSize: new TextEncoder().encode(rawText).byteLength,
      setReject,
      forward,
      reply,
    } as unknown as ForwardableEmailMessage,
    setReject,
    forward,
    rawText,
  }
}
