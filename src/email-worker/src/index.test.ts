import { describe, it, expect, vi, beforeEach } from "vitest"
import { createMockR2, createMockFetcher, createMockMessage } from "./__mocks__/cf"

// Mock nanoid to return predictable IDs
let nanoidCounter = 0
vi.mock("nanoid", () => ({
  nanoid: () => `mock-id-${++nanoidCounter}`,
}))

// Mock @alook/shared at module level — the handler never touches Drizzle
const mockGetAgentByHandle = vi.fn<(db: unknown, handle: unknown) => unknown>()
const mockIsWhitelisted = vi.fn<(db: unknown, agentId: unknown, email: unknown) => unknown>()
const mockGetUser = vi.fn<(db: unknown, id: unknown) => unknown>()
const mockCreateDb = vi.fn<(d1: unknown) => Record<string, unknown>>().mockReturnValue({})

vi.mock("@alook/shared", () => ({
  createDb: (d1: unknown) => mockCreateDb(d1),
  parseEmailHandle: (address: string) => {
    const domain = "@alook.ai"
    return address.endsWith(domain) ? address.slice(0, -domain.length) : ""
  },
  queries: {
    agent: { getAgentByHandle: (db: unknown, handle: unknown) => mockGetAgentByHandle(db, handle) },
    whitelist: { isWhitelisted: (db: unknown, agentId: unknown, email: unknown) => mockIsWhitelisted(db, agentId, email) },
    user: { getUser: (db: unknown, id: unknown) => mockGetUser(db, id) },
  },
}))

// Import handler after mocks are set up
import handler from "./index"

// Standard agent fixture
const AGENT = {
  id: "agent-1",
  workspaceId: "ws-1",
  ownerId: "user-1" as string | null,
  emailHandle: "jarvis",
  forwardToEmail: "",
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
  const { message, setReject, forward, rawText } = createMockMessage(
    overrides?.messageOpts ?? {
      from: "owner@example.com",
      to: "jarvis@alook.ai",
      subject: "Hello",
      body: "Test body",
    }
  )

  const env = { DB: {} as D1Database, EMAIL_BUCKET: bucket, WEB_SERVICE: fetcher }

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
    expect(key).toBe("emails/mock-id-1/raw")
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
    expect(body.r2Key).toBe("emails/mock-id-1/raw")
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
})

// ─── Group 4: Non-whitelisted path ───

describe("non-whitelisted path", () => {
  const strangerOpts = {
    messageOpts: { from: "stranger@example.com", to: "jarvis@alook.ai", subject: "Spam" } as const,
  }

  it("notifies web service with isWhitelisted: false", async () => {
    const { env, message, wsFetch } = setup({
      ...strangerOpts,
      isWhitelisted: false,
      agentOverrides: { forwardToEmail: "fwd@corp.com" },
    })

    await handler.email(message, env)

    expect(wsFetch).toHaveBeenCalledOnce()
    const body = JSON.parse(wsFetch.mock.calls[0][1].body)
    expect(body.isWhitelisted).toBe(false)
    expect(body.forwarded).toBe(true)
  })

  it("forwards email when forwardToEmail is set on agent", async () => {
    const { env, message, forward } = setup({
      ...strangerOpts,
      isWhitelisted: false,
      agentOverrides: { forwardToEmail: "fwd@corp.com" },
    })

    await handler.email(message, env)

    expect(forward).toHaveBeenCalledWith("fwd@corp.com")
  })

  it("notifies with forwarded: false when no forward address", async () => {
    const { env, message, wsFetch } = setup({
      ...strangerOpts,
      isWhitelisted: false,
      agentOverrides: { forwardToEmail: "", ownerId: null },
    })

    await handler.email(message, env)

    const body = JSON.parse(wsFetch.mock.calls[0][1].body)
    expect(body.isWhitelisted).toBe(false)
    expect(body.forwarded).toBe(false)
  })

  it("does NOT forward when forwardToEmail is empty", async () => {
    const { env, message, forward } = setup({
      ...strangerOpts,
      isWhitelisted: false,
      agentOverrides: { forwardToEmail: "", ownerId: null },
    })

    await handler.email(message, env)

    expect(forward).not.toHaveBeenCalled()
  })

  it("falls back to user email when forwardToEmail is empty", async () => {
    const { env, message, forward } = setup({
      ...strangerOpts,
      isWhitelisted: false,
      agentOverrides: { forwardToEmail: "", ownerId: "user-1" },
      userEmail: "fallback@example.com",
    })

    await handler.email(message, env)

    expect(mockGetUser).toHaveBeenCalledWith(expect.anything(), "user-1")
    expect(forward).toHaveBeenCalledWith("fallback@example.com")
  })

  it("does not call getUser when forwardToEmail is set", async () => {
    const { env, message } = setup({
      ...strangerOpts,
      isWhitelisted: false,
      agentOverrides: { forwardToEmail: "fwd@corp.com" },
    })

    await handler.email(message, env)

    expect(mockGetUser).not.toHaveBeenCalled()
  })
})
