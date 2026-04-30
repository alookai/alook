import { describe, it, expect, vi, beforeEach } from "vitest"
import { createMockR2, createMockFetcher, createMockMessage, createMockSendEmail } from "./__mocks__/cf"

// Mock cloudflare:workers (DO base class) — needed because index.ts re-exports ImapPollerDO
vi.mock("cloudflare:workers", () => ({
  DurableObject: class {},
}))

// Mock imap-client — imported transitively via imap-poller-do
vi.mock("./lib/imap-client", () => ({
  ImapClient: class {},
  ImapAuthError: class extends Error {},
  ImapError: class extends Error {},
}))

// Mock worker-mailer
const mockWorkerMailerSend = vi.fn().mockResolvedValue(undefined)
vi.mock("worker-mailer", () => ({
  WorkerMailer: { send: (...args: any[]) => mockWorkerMailerSend(...args) },
}))

// Mock @alook/shared/crypto (separate subpath export, not in barrel)
vi.mock("@alook/shared/crypto", () => ({
  encrypt: (val: string) => `encrypted:${val}`,
  decrypt: (val: string) => `decrypted:${val}`,
}))

// Mock nanoid to return predictable IDs
let nanoidCounter = 0
vi.mock("nanoid", () => ({
  nanoid: () => `mock-id-${++nanoidCounter}`,
}))

// Mock @alook/shared at module level — the handler never touches Drizzle
const mockGetAgentByHandle = vi.fn<(db: unknown, handle: unknown) => unknown>()
const mockGetAgent = vi.fn<(db: unknown, id: unknown, workspaceId: unknown) => unknown>()
const mockIsWhitelisted = vi.fn<(db: unknown, agentId: unknown, workspaceId: unknown, email: unknown) => unknown>()
const mockGetUser = vi.fn<(db: unknown, id: unknown) => unknown>()
const mockGetEmailAccount = vi.fn()
const mockCreateDb = vi.fn<(d1: unknown) => Record<string, unknown>>().mockReturnValue({})

vi.mock("@alook/shared", async () => {
  const real = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  const noopLogger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => noopLogger,
  }
  return {
    buildMimeMessage: real.buildMimeMessage,
    createDb: (d1: unknown) => mockCreateDb(d1),
    createLogger: () => noopLogger,
    parseEmailHandle: (address: string) => {
      const domain = "@alook.ai"
      return address.endsWith(domain) ? address.slice(0, -domain.length) : ""
    },
    DEV_WEB_URL: "http://localhost:3000",
    queries: {
      agent: {
        getAgentByHandle: (db: unknown, handle: unknown) => mockGetAgentByHandle(db, handle),
        getAgent: (db: unknown, id: unknown, workspaceId: unknown) => mockGetAgent(db, id, workspaceId),
      },
      whitelist: { isWhitelisted: (db: unknown, agentId: unknown, workspaceId: unknown, email: unknown) => mockIsWhitelisted(db, agentId, workspaceId, email) },
      user: { getUser: (db: unknown, id: unknown) => mockGetUser(db, id) },
      emailAccount: { getEmailAccount: (...args: unknown[]) => mockGetEmailAccount(...args), getEmailAccountById: (...args: unknown[]) => mockGetEmailAccount(...args) },
    },
  }
})

// Import handler after mocks are set up
import handler from "./index"

// Standard agent fixture
const AGENT = {
  id: "agent-1",
  workspaceId: "ws-1",
  ownerId: "user-1" as string | null,
  emailHandle: "jarvis",
  name: "Jarvis",
  status: "idle",
}

function setup(overrides?: {
  agentOverrides?: Partial<typeof AGENT> | null
  isWhitelisted?: boolean
  userEmail?: string | null
  messageOpts?: Parameters<typeof createMockMessage>[0]
}) {
  const agent = overrides?.agentOverrides === null
    ? null
    : { ...AGENT, ...(overrides?.agentOverrides ?? {}) }

  mockGetAgentByHandle.mockResolvedValue(agent)
  mockIsWhitelisted.mockResolvedValue(overrides?.isWhitelisted ?? false)
  mockGetUser.mockResolvedValue(
    overrides?.userEmail !== undefined
      ? (overrides.userEmail ? { id: "user-1", email: overrides.userEmail } : null)
      : { id: "user-1", email: "owner@example.com" }
  )

  const { bucket, put } = createMockR2()
  const { fetcher, fetch: wsFetch } = createMockFetcher()
  const { sendEmail } = createMockSendEmail()
  const { message, setReject, forward, rawText } = createMockMessage(
    overrides?.messageOpts ?? {
      from: "owner@example.com",
      to: "jarvis@alook.ai",
      subject: "Hello",
      body: "Test body",
    }
  )

  const env = { DB: {} as D1Database, EMAIL_BUCKET: bucket, WEB_SERVICE: fetcher, SEND_EMAIL: sendEmail, IMAP_POLLER: {} as DurableObjectNamespace, ENCRYPTION_KEY: "test-secret" }

  return { env, message, put, wsFetch, setReject, forward, rawText }
}

beforeEach(() => {
  nanoidCounter = 0
  vi.clearAllMocks()
})

// ─── Group 1: Agent resolution ───

describe("agent resolution", () => {
  it("rejects when no agent found for handle", async () => {
    const { env, message, setReject, put } = setup({ agentOverrides: null })

    await handler.email(message, env)

    expect(setReject).toHaveBeenCalledWith("No agent found for this address")
    expect(put).not.toHaveBeenCalled()
  })

  it("parses handle from alook.ai address and looks up agent", async () => {
    const { env, message } = setup({ isWhitelisted: true })

    await handler.email(message, env)

    expect(mockGetAgentByHandle).toHaveBeenCalledWith(expect.anything(), "jarvis")
  })

  it("rejects for non-alook domain (empty handle)", async () => {
    const { env, message, setReject } = setup({
      agentOverrides: null,
      messageOpts: { from: "sender@example.com", to: "user@gmail.com", subject: "Hi" },
    })

    await handler.email(message, env)

    expect(setReject).toHaveBeenCalledWith("No agent found for this address")
  })
})

// ─── Group 2: R2 storage ───

describe("R2 storage", () => {
  it("stores raw email bytes at emails/{id}/raw with correct content-type", async () => {
    const { env, message, put } = setup({ isWhitelisted: true })

    await handler.email(message, env)

    expect(put).toHaveBeenCalledOnce()
    const [key, _body, opts] = put.mock.calls[0]
    expect(key).toBe("emails/mock-id-2/raw")
    expect(opts).toEqual({ httpMetadata: { contentType: "message/rfc822" } })
  })

  it("R2 put receives ArrayBuffer matching raw email content", async () => {
    const { env, message, put, rawText } = setup({ isWhitelisted: true })

    await handler.email(message, env)

    const storedBody = put.mock.calls[0][1] as ArrayBuffer
    const decoded = new TextDecoder().decode(storedBody)
    expect(decoded).toBe(rawText)
  })
})

// ─── Group 3: Whitelisted path ───

describe("whitelisted path", () => {
  it("notifies web service with isWhitelisted: true", async () => {
    const { env, message, wsFetch } = setup({ isWhitelisted: true })

    await handler.email(message, env)

    expect(wsFetch).toHaveBeenCalledOnce()
    const [url, init] = wsFetch.mock.calls[0]
    expect(url).toBe("http://internal/api/email/notify")
    expect(init.method).toBe("POST")
    const body = JSON.parse(init.body)
    expect(body.agentId).toBe("agent-1")
    expect(body.workspaceId).toBe("ws-1")
    expect(body.r2Key).toBe("emails/mock-id-2/raw")
    expect(body.from).toBe("owner@example.com")
    expect(body.subject).toBe("Hello")
    expect(body.isWhitelisted).toBe(true)
    expect(body.forwarded).toBeUndefined()
  })

  it("defaults subject to empty string when header is missing", async () => {
    const { env, message, wsFetch } = setup({
      isWhitelisted: true,
      messageOpts: { from: "owner@example.com", to: "jarvis@alook.ai", subject: null },
    })

    await handler.email(message, env)

    const notifyBody = JSON.parse(wsFetch.mock.calls[0][1].body)
    expect(notifyBody.subject).toBe("")
  })

  it("does NOT call message.forward", async () => {
    const { env, message, forward } = setup({ isWhitelisted: true })

    await handler.email(message, env)

    expect(forward).not.toHaveBeenCalled()
  })

  it("passes threading headers (Message-ID, In-Reply-To, References) to notify", async () => {
    const { env, message, wsFetch } = setup({
      isWhitelisted: true,
      messageOpts: {
        from: "owner@example.com",
        to: "jarvis@alook.ai",
        subject: "Re: Thread",
        extraHeaders: {
          "message-id": "<msg-123@example.com>",
          "in-reply-to": "<parent-456@example.com>",
          "references": "<root-789@example.com> <parent-456@example.com>",
        },
      },
    })

    await handler.email(message, env)

    const body = JSON.parse(wsFetch.mock.calls[0][1].body)
    expect(body.messageId).toBe("<msg-123@example.com>")
    expect(body.inReplyTo).toBe("<parent-456@example.com>")
    expect(body.references).toBe("<root-789@example.com> <parent-456@example.com>")
  })

  it("passes empty threading fields when headers are absent", async () => {
    const { env, message, wsFetch } = setup({ isWhitelisted: true })

    await handler.email(message, env)

    const body = JSON.parse(wsFetch.mock.calls[0][1].body)
    expect(body.messageId).toBe("")
    expect(body.inReplyTo).toBe("")
    expect(body.references).toBe("")
  })
})

// ─── Group 4: Non-whitelisted path (rejected) ───

describe("non-whitelisted path", () => {
  const strangerOpts = {
    messageOpts: { from: "stranger@example.com", to: "jarvis@alook.ai", subject: "Spam" } as const,
  }

  it("notifies web service with isWhitelisted: false and forwarded: false", async () => {
    const { env, message, wsFetch } = setup({
      ...strangerOpts,
      isWhitelisted: false,
    })

    await handler.email(message, env)

    expect(wsFetch).toHaveBeenCalledOnce()
    const body = JSON.parse(wsFetch.mock.calls[0][1].body)
    expect(body.isWhitelisted).toBe(false)
    expect(body.forwarded).toBe(false)
  })

  it("rejects email with setReject", async () => {
    const { env, message, setReject } = setup({
      ...strangerOpts,
      isWhitelisted: false,
    })

    await handler.email(message, env)

    expect(setReject).toHaveBeenCalledWith("Sender not whitelisted")
  })

  it("does NOT forward email", async () => {
    const { env, message, forward } = setup({
      ...strangerOpts,
      isWhitelisted: false,
    })

    await handler.email(message, env)

    expect(forward).not.toHaveBeenCalled()
  })

  it("still stores raw email in R2", async () => {
    const { env, message, put } = setup({
      ...strangerOpts,
      isWhitelisted: false,
    })

    await handler.email(message, env)

    expect(put).toHaveBeenCalledOnce()
  })
})

// ─── Group 5: POST /send/otp ───

describe("POST /send/otp", () => {
  function makeOtpRequest(body: Record<string, unknown>) {
    return new Request("http://localhost/send/otp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  }

  function otpEnv() {
    const { bucket } = createMockR2()
    const { fetcher } = createMockFetcher()
    const { sendEmail, send } = createMockSendEmail()
    return {
      env: { DB: {} as D1Database, EMAIL_BUCKET: bucket, WEB_SERVICE: fetcher, SEND_EMAIL: sendEmail, IMAP_POLLER: {} as DurableObjectNamespace, ENCRYPTION_KEY: "test-secret" },
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

// ─── Group 6: POST /send/agent ───

describe("POST /send/agent", () => {
  function makeAgentSendRequest(body: Record<string, unknown>) {
    return new Request("http://localhost/send/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  }

  function agentSendEnv() {
    const { bucket, put } = createMockR2()
    const { fetcher } = createMockFetcher()
    const { sendEmail, send } = createMockSendEmail()
    return {
      env: { DB: {} as D1Database, EMAIL_BUCKET: bucket, WEB_SERVICE: fetcher, SEND_EMAIL: sendEmail, IMAP_POLLER: {} as DurableObjectNamespace, ENCRYPTION_KEY: "test-secret" },
      send,
      put,
      bucket,
    }
  }

  it("sends agent email and stores MIME archive in R2", async () => {
    mockGetAgent.mockResolvedValue({ id: "agent-1", workspaceId: "ws-1", emailHandle: "jarvis" })
    const { env, send, put } = agentSendEnv()

    const res = await handler.fetch(
      makeAgentSendRequest({
        agentId: "agent-1",
        workspaceId: "ws-1",
        to: "user@example.com",
        subject: "Hello",
        htmlBody: "<p>Hi there</p>",
      }),
      env,
    )

    expect(res.status).toBe(200)
    const json = await res.json() as { ok: boolean; r2Key: string }
    expect(json.ok).toBe(true)
    expect(json.r2Key).toMatch(/^emails\/mock-id-\d+\/raw$/)

    // Verify SEND_EMAIL.send was called with builder
    expect(send).toHaveBeenCalledOnce()
    const sendArg = send.mock.calls[0][0]
    expect(sendArg.from).toBe("jarvis@alook.ai")
    expect(sendArg.to).toBe("user@example.com")
    expect(sendArg.subject).toBe("Hello")
    expect(sendArg.html).toBe("<p>Hi there</p>")

    // Verify R2 archive
    expect(put).toHaveBeenCalledOnce()
    const [key, body, opts] = put.mock.calls[0]
    expect(key).toMatch(/^emails\/mock-id-\d+\/raw$/)
    expect(opts).toEqual({ httpMetadata: { contentType: "message/rfc822" } })
    expect(body).toContain("From: jarvis@alook.ai")
    expect(body).toContain("To: user@example.com")
    expect(body).toContain("Subject: Hello")
    expect(body).toContain("Content-Type: text/html; charset=utf-8")
  })

  it("sends agent email with attachments from R2", async () => {
    mockGetAgent.mockResolvedValue({ id: "agent-1", workspaceId: "ws-1", emailHandle: "jarvis" })
    const { env, send, put, bucket } = agentSendEnv()

    const fileContent = new TextEncoder().encode("file content")
    ;(bucket as any).get = vi.fn().mockResolvedValue({
      arrayBuffer: () => Promise.resolve(fileContent.buffer),
    })

    const res = await handler.fetch(
      makeAgentSendRequest({
        agentId: "agent-1",
        workspaceId: "ws-1",
        to: "user@example.com",
        subject: "With attachment",
        htmlBody: "<p>See attached</p>",
        attachmentKeys: [
          { key: "emails/drafts/x/doc.txt", filename: "doc.txt", contentType: "text/plain" },
        ],
      }),
      env,
    )

    expect(res.status).toBe(200)

    // Verify SEND_EMAIL.send includes attachments with raw ArrayBuffer content
    const sendArg = send.mock.calls[0][0]
    expect(sendArg.attachments).toHaveLength(1)
    expect(sendArg.attachments[0].filename).toBe("doc.txt")
    expect(sendArg.attachments[0].type).toBe("text/plain")
    expect(sendArg.attachments[0].disposition).toBe("attachment")
    expect(sendArg.attachments[0].content).toBeInstanceOf(ArrayBuffer)
    const decoded = new TextDecoder().decode(sendArg.attachments[0].content)
    expect(decoded).toBe("file content")

    // Verify R2 MIME archive contains attachment
    const storedMime = put.mock.calls[0][1] as string
    expect(storedMime).toContain("multipart/mixed")
    expect(storedMime).toContain('Content-Disposition: attachment; filename="doc.txt"')
    expect(storedMime).toContain("Content-Transfer-Encoding: base64")
  })

  it("returns 404 when agent not found in workspace", async () => {
    mockGetAgent.mockResolvedValue(null)
    const { env } = agentSendEnv()

    const res = await handler.fetch(
      makeAgentSendRequest({
        agentId: "agent-1",
        workspaceId: "ws-1",
        to: "user@example.com",
        subject: "Hello",
        htmlBody: "<p>Hi</p>",
      }),
      env,
    )

    expect(res.status).toBe(404)
  })

  it("returns 400 when agent has no email handle", async () => {
    mockGetAgent.mockResolvedValue({ id: "agent-1", workspaceId: "ws-1", emailHandle: "" })
    const { env } = agentSendEnv()

    const res = await handler.fetch(
      makeAgentSendRequest({
        agentId: "agent-1",
        workspaceId: "ws-1",
        to: "user@example.com",
        subject: "Hello",
        htmlBody: "<p>Hi</p>",
      }),
      env,
    )

    expect(res.status).toBe(400)
  })

  it("returns 400 when required fields are missing", async () => {
    const { env } = agentSendEnv()

    const res = await handler.fetch(
      makeAgentSendRequest({ agentId: "agent-1" }),
      env,
    )

    expect(res.status).toBe(400)
  })

  it("includes threading headers in outgoing MIME when inReplyTo/references provided", async () => {
    mockGetAgent.mockResolvedValue({ id: "agent-1", workspaceId: "ws-1", emailHandle: "jarvis" })
    const { env, put } = agentSendEnv()

    const res = await handler.fetch(
      makeAgentSendRequest({
        agentId: "agent-1",
        workspaceId: "ws-1",
        to: "user@example.com",
        subject: "Re: Thread test",
        htmlBody: "<p>Reply</p>",
        inReplyTo: "<parent-123@example.com>",
        references: "<root-000@example.com> <parent-123@example.com>",
      }),
      env,
    )

    expect(res.status).toBe(200)
    const json = await res.json() as { ok: boolean; messageId: string }
    expect(json.messageId).toMatch(/@alook\.ai>$/)

    const storedMime = put.mock.calls[0][1] as string
    expect(storedMime).toContain("Message-ID: " + json.messageId)
    expect(storedMime).toContain("In-Reply-To: <parent-123@example.com>")
    expect(storedMime).toContain("References: <root-000@example.com> <parent-123@example.com>")
  })

  it("generates Message-ID but omits In-Reply-To/References when not provided", async () => {
    mockGetAgent.mockResolvedValue({ id: "agent-1", workspaceId: "ws-1", emailHandle: "jarvis" })
    const { env, put } = agentSendEnv()

    const res = await handler.fetch(
      makeAgentSendRequest({
        agentId: "agent-1",
        workspaceId: "ws-1",
        to: "user@example.com",
        subject: "New email",
        htmlBody: "<p>Fresh</p>",
      }),
      env,
    )

    expect(res.status).toBe(200)
    const json = await res.json() as { ok: boolean; messageId: string }
    expect(json.messageId).toMatch(/@alook\.ai>$/)

    const storedMime = put.mock.calls[0][1] as string
    expect(storedMime).toContain("Message-ID:")
    expect(storedMime).not.toContain("In-Reply-To:")
    expect(storedMime).not.toContain("References:")
  })
})

// ─── Group 7: POST /send/agent with custom SMTP ───

describe("POST /send/agent with custom SMTP", () => {
  const CUSTOM_ACCOUNT = {
    id: "aea_1",
    agentId: "agent-1",
    workspaceId: "ws-1",
    emailAddress: "user@gmail.com",
    displayName: "Custom User",
    smtpHost: "smtp.gmail.com",
    smtpPort: 587,
    smtpUsername: "enc-user",
    smtpPassword: "enc-pass",
    smtpTls: 1,
  }

  function makeRequest(body: Record<string, unknown>) {
    return new Request("http://localhost/send/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  }

  function customSmtpEnv() {
    const { bucket, put } = createMockR2()
    const { fetcher } = createMockFetcher()
    const { sendEmail, send } = createMockSendEmail()
    return {
      env: { DB: {} as D1Database, EMAIL_BUCKET: bucket, WEB_SERVICE: fetcher, SEND_EMAIL: sendEmail, IMAP_POLLER: {} as DurableObjectNamespace, ENCRYPTION_KEY: "test-secret" },
      send,
      put,
    }
  }

  it("sends via worker-mailer when customAccountId is provided", async () => {
    mockGetAgent.mockResolvedValue({ id: "agent-1", workspaceId: "ws-1", emailHandle: "jarvis" })
    mockGetEmailAccount.mockResolvedValue(CUSTOM_ACCOUNT)
    const { env, send } = customSmtpEnv()

    const res = await handler.fetch(
      makeRequest({
        agentId: "agent-1",
        workspaceId: "ws-1",
        to: "recipient@example.com",
        subject: "Custom SMTP test",
        htmlBody: "<p>Hello</p>",
        customAccountId: "aea_1",
      }),
      env,
    )

    expect(res.status).toBe(200)
    expect(send).not.toHaveBeenCalled()
    expect(mockWorkerMailerSend).toHaveBeenCalledOnce()

    const [smtpOpts, emailOpts] = mockWorkerMailerSend.mock.calls[0]
    expect(smtpOpts.host).toBe("smtp.gmail.com")
    expect(smtpOpts.port).toBe(587)
    expect(smtpOpts.startTls).toBe(true)
    expect(smtpOpts.credentials.username).toBe("decrypted:enc-user")
    expect(smtpOpts.credentials.password).toBe("decrypted:enc-pass")
    expect(emailOpts.from).toEqual({ name: "Custom User", email: "user@gmail.com" })
    expect(emailOpts.to).toBe("recipient@example.com")
    expect(emailOpts.subject).toBe("Custom SMTP test")
  })

  it("falls back to CF SendEmail when no customAccountId", async () => {
    mockGetAgent.mockResolvedValue({ id: "agent-1", workspaceId: "ws-1", emailHandle: "jarvis" })
    const { env, send } = customSmtpEnv()

    const res = await handler.fetch(
      makeRequest({
        agentId: "agent-1",
        workspaceId: "ws-1",
        to: "recipient@example.com",
        subject: "Default path",
        htmlBody: "<p>Hi</p>",
      }),
      env,
    )

    expect(res.status).toBe(200)
    expect(send).toHaveBeenCalledOnce()
    expect(mockWorkerMailerSend).not.toHaveBeenCalled()
  })

  it("returns 404 when customAccountId not found", async () => {
    mockGetAgent.mockResolvedValue({ id: "agent-1", workspaceId: "ws-1", emailHandle: "jarvis" })
    mockGetEmailAccount.mockResolvedValue(null)
    const { env } = customSmtpEnv()

    const res = await handler.fetch(
      makeRequest({
        agentId: "agent-1",
        workspaceId: "ws-1",
        to: "recipient@example.com",
        subject: "Test",
        customAccountId: "aea_nonexistent",
      }),
      env,
    )

    expect(res.status).toBe(404)
  })

  it("sends attachments as base64 strings via worker-mailer", async () => {
    mockGetAgent.mockResolvedValue({ id: "agent-1", workspaceId: "ws-1", emailHandle: "jarvis" })
    mockGetEmailAccount.mockResolvedValue(CUSTOM_ACCOUNT)
    const { env, send, put } = customSmtpEnv()

    const fileContent = new TextEncoder().encode("hello attachment")
    ;((env.EMAIL_BUCKET as any).get as ReturnType<typeof vi.fn>) = vi.fn().mockResolvedValue({
      arrayBuffer: () => Promise.resolve(fileContent.buffer),
    })

    const res = await handler.fetch(
      makeRequest({
        agentId: "agent-1",
        workspaceId: "ws-1",
        to: "recipient@example.com",
        subject: "SMTP with attachment",
        htmlBody: "<p>See file</p>",
        customAccountId: "aea_1",
        attachmentKeys: [
          { key: "emails/drafts/x/report.pdf", filename: "report.pdf", contentType: "application/pdf" },
        ],
      }),
      env,
    )

    expect(res.status).toBe(200)
    expect(send).not.toHaveBeenCalled()
    expect(mockWorkerMailerSend).toHaveBeenCalledOnce()

    const [, emailOpts] = mockWorkerMailerSend.mock.calls[0]
    expect(emailOpts.attachments).toHaveLength(1)
    expect(emailOpts.attachments[0].filename).toBe("report.pdf")
    expect(emailOpts.attachments[0].mimeType).toBe("application/pdf")
    // WorkerMailer expects base64 string, NOT ArrayBuffer
    expect(typeof emailOpts.attachments[0].content).toBe("string")
    expect(emailOpts.attachments[0].content).toBe(btoa("hello attachment"))
  })

  it("returns 500 when SMTP send fails", async () => {
    mockGetAgent.mockResolvedValue({ id: "agent-1", workspaceId: "ws-1", emailHandle: "jarvis" })
    mockGetEmailAccount.mockResolvedValue(CUSTOM_ACCOUNT)
    mockWorkerMailerSend.mockRejectedValueOnce(new Error("SMTP auth failed"))
    const { env } = customSmtpEnv()

    const res = await handler.fetch(
      makeRequest({
        agentId: "agent-1",
        workspaceId: "ws-1",
        to: "recipient@example.com",
        subject: "Test",
        htmlBody: "<p>Hi</p>",
        customAccountId: "aea_1",
      }),
      env,
    )

    expect(res.status).toBe(500)
    const json = await res.json() as { error: string }
    expect(json.error).toContain("SMTP send failed")
  })
})

// ─── Group 8: fetch() routing ───

describe("fetch() routing", () => {
  function routingEnv() {
    const { bucket } = createMockR2()
    const { fetcher } = createMockFetcher()
    const { sendEmail } = createMockSendEmail()
    return { DB: {} as D1Database, EMAIL_BUCKET: bucket, WEB_SERVICE: fetcher, SEND_EMAIL: sendEmail, IMAP_POLLER: {} as DurableObjectNamespace, ENCRYPTION_KEY: "test-secret" }
  }

  it("returns 404 for unknown paths", async () => {
    const res = await handler.fetch(
      new Request("http://localhost/unknown", { method: "POST" }),
      routingEnv(),
    )
    expect(res.status).toBe(404)
  })

  it("returns 405 for non-POST methods", async () => {
    const res = await handler.fetch(
      new Request("http://localhost/send/otp", { method: "GET" }),
      routingEnv(),
    )
    expect(res.status).toBe(405)
  })
})

// ─── Group 8: IMAP management routes ───

describe("IMAP management routes", () => {
  function imapEnv() {
    const { bucket } = createMockR2()
    const { fetcher } = createMockFetcher()
    const { sendEmail } = createMockSendEmail()
    const doFetch = vi.fn().mockResolvedValue(Response.json({ ok: true }))
    const mockStub = { fetch: doFetch }
    const mockIdFromName = vi.fn().mockReturnValue("do-id-1")
    const mockGet = vi.fn().mockReturnValue(mockStub)
    const imapPoller = { idFromName: mockIdFromName, get: mockGet } as unknown as DurableObjectNamespace
    return {
      env: { DB: {} as D1Database, EMAIL_BUCKET: bucket, WEB_SERVICE: fetcher, SEND_EMAIL: sendEmail, IMAP_POLLER: imapPoller, ENCRYPTION_KEY: "test-secret" },
      doFetch,
      mockIdFromName,
      mockGet,
    }
  }

  it("POST /imap/start forwards to DO with accountId", async () => {
    const { env, doFetch, mockIdFromName } = imapEnv()
    const res = await handler.fetch(
      new Request("http://localhost/imap/start?accountId=acc-1", { method: "POST" }),
      env,
    )
    expect(res.status).toBe(200)
    expect(mockIdFromName).toHaveBeenCalledWith("acc-1")
    expect(doFetch).toHaveBeenCalledOnce()
    const [req] = doFetch.mock.calls[0] as [Request]
    expect(new URL(req.url).pathname).toBe("/start")
    const body = await req.json()
    expect(body).toEqual({ accountId: "acc-1" })
  })

  it("POST /imap/stop forwards to DO", async () => {
    const { env, doFetch } = imapEnv()
    const res = await handler.fetch(
      new Request("http://localhost/imap/stop?accountId=acc-1", { method: "POST" }),
      env,
    )
    expect(res.status).toBe(200)
    const [req] = doFetch.mock.calls[0] as [Request]
    expect(new URL(req.url).pathname).toBe("/stop")
  })

  it("POST /imap/sync forwards to DO", async () => {
    const { env, doFetch } = imapEnv()
    const res = await handler.fetch(
      new Request("http://localhost/imap/sync?accountId=acc-1", { method: "POST" }),
      env,
    )
    expect(res.status).toBe(200)
    const [req] = doFetch.mock.calls[0] as [Request]
    expect(new URL(req.url).pathname).toBe("/sync")
  })

  it("GET /imap/status forwards to DO", async () => {
    const { env, doFetch } = imapEnv()
    const res = await handler.fetch(
      new Request("http://localhost/imap/status?accountId=acc-1", { method: "GET" }),
      env,
    )
    expect(res.status).toBe(200)
    const [req] = doFetch.mock.calls[0] as [Request]
    expect(new URL(req.url).pathname).toBe("/status")
    expect(req.method).toBe("GET")
  })

  it("returns 400 when accountId is missing", async () => {
    const { env } = imapEnv()
    const res = await handler.fetch(
      new Request("http://localhost/imap/start", { method: "POST" }),
      env,
    )
    expect(res.status).toBe(400)
  })
})
