import { describe, it, expect, vi, beforeEach } from "vitest"

// Mock cloudflare:workers — provide a real-enough DurableObject base class
vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: any
    env: any
    constructor(ctx: any, env: any) {
      this.ctx = ctx
      this.env = env
    }
  },
}))

// Mock cf-imap — using vi.hoisted so mock fns are available inside vi.mock factory
const { mockConnect, mockSelectFolder, mockSearchEmails, mockFetchEmails, mockLogout } = vi.hoisted(() => ({
  mockConnect: vi.fn().mockResolvedValue(undefined),
  mockSelectFolder: vi.fn().mockResolvedValue({ exists: 5 }),
  mockSearchEmails: vi.fn<() => Promise<number[]>>().mockResolvedValue([]),
  mockFetchEmails: vi.fn<() => Promise<any[]>>().mockResolvedValue([]),
  mockLogout: vi.fn().mockResolvedValue(true),
}))

const { mockStoreWriter } = vi.hoisted(() => ({
  mockStoreWriter: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("cf-imap", () => {
  return {
    CFImap: class {
      connect = mockConnect
      selectFolder = mockSelectFolder
      searchEmails = mockSearchEmails
      fetchEmails = mockFetchEmails
      logout = mockLogout
      writer = { write: mockStoreWriter }
      reader = { read: vi.fn().mockResolvedValue({ value: new Uint8Array() }) }
      encoder = new TextEncoder()
    },
  }
})

// Mock nanoid
let nanoidCounter = 0
vi.mock("nanoid", () => ({
  nanoid: (len?: number) => `mock-${++nanoidCounter}`,
}))

// Mock @alook/shared/crypto
vi.mock("@alook/shared/crypto", () => ({
  encrypt: (val: string) => `encrypted:${val}`,
  decrypt: (val: string) => `decrypted:${val}`,
}))

// Mock @alook/shared
const mockGetEmailAccount = vi.fn()
const mockUpdateEmailAccount = vi.fn()
const mockIsWhitelisted = vi.fn().mockResolvedValue(true)

vi.mock("@alook/shared", () => {
  const noopLogger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => noopLogger,
  }
  return {
    createDb: () => ({}),
    createLogger: () => noopLogger,
    DEV_WEB_URL: "http://localhost:3000",
    queries: {
      emailAccount: {
        getEmailAccount: (...args: any[]) => mockGetEmailAccount(...args),
        getEmailAccountById: (...args: any[]) => mockGetEmailAccount(...args),
        updateEmailAccount: (...args: any[]) => mockUpdateEmailAccount(...args),
      },
      whitelist: {
        isWhitelisted: (...args: any[]) => mockIsWhitelisted(...args),
      },
    },
  }
})

import { ImapPollerDO } from "./imap-poller-do"

const ACCOUNT = {
  id: "aea_test1",
  agentId: "ag_test1",
  workspaceId: "ws_test1",
  emailAddress: "user@gmail.com",
  imapHost: "imap.gmail.com",
  imapPort: 993,
  imapUsername: "enc-user",
  imapPassword: "enc-pass",
  imapTls: true,
  smtpHost: "smtp.gmail.com",
  smtpPort: 587,
  smtpUsername: "enc-user",
  smtpPassword: "enc-pass",
  smtpTls: 1,
  pollIntervalSeconds: 60,
  lastSyncedUid: "0",
  lastSyncedAt: null,
  status: "active",
  errorMessage: "",
}

function createMockCtx() {
  const storage = new Map<string, any>()
  let alarm: number | null = null
  const ctx = {
    storage: {
      get: vi.fn(async (key: string) => storage.get(key)),
      put: vi.fn(async (key: string, val: any) => { storage.set(key, val) }),
      delete: vi.fn(async (key: string) => { storage.delete(key) }),
      deleteAll: vi.fn(async () => { storage.clear() }),
      setAlarm: vi.fn(async (time: number) => { alarm = time }),
      deleteAlarm: vi.fn(async () => { alarm = null }),
    },
    getWebSockets: vi.fn().mockReturnValue([]),
  }
  return { ctx, storage, getAlarm: () => alarm }
}

function createMockEnv() {
  const putR2 = vi.fn().mockResolvedValue(undefined)
  const webFetch = vi.fn().mockResolvedValue(new Response("ok"))
  return {
    env: {
      DB: {} as D1Database,
      EMAIL_BUCKET: { put: putR2 } as unknown as R2Bucket,
      WEB_SERVICE: { fetch: webFetch } as unknown as Fetcher,
      SEND_EMAIL: {} as SendEmail,
      IMAP_POLLER: {} as DurableObjectNamespace,
      ENCRYPTION_KEY: "test-secret",
    },
    putR2,
    webFetch,
  }
}

function createDO() {
  const { ctx, storage, getAlarm } = createMockCtx()
  const { env, putR2, webFetch } = createMockEnv()
  const durable = new ImapPollerDO(ctx as any, env as any)
  return { durable, ctx, storage, env, putR2, webFetch, getAlarm }
}

beforeEach(() => {
  nanoidCounter = 0
  vi.clearAllMocks()
  mockGetEmailAccount.mockResolvedValue({ ...ACCOUNT })
  mockUpdateEmailAccount.mockResolvedValue(undefined)
  mockIsWhitelisted.mockResolvedValue(true)
  mockSearchEmails.mockResolvedValue([])
  mockFetchEmails.mockResolvedValue([])
})

// ─── T3: alarm normal flow ───

describe("alarm — normal flow", () => {
  it("fetches unseen emails, stores in R2, notifies web, and reschedules", async () => {
    const { durable, ctx, putR2, webFetch } = createDO()

    mockSearchEmails.mockResolvedValue([1, 2])
    mockFetchEmails.mockResolvedValue([
      { from: "alice@example.com", to: "user@gmail.com", subject: "Hi", messageID: "<msg1>", raw: "raw1", body: "", contentType: "text/plain", date: new Date() },
      { from: "bob@example.com", to: "user@gmail.com", subject: "Hey", messageID: "<msg2>", raw: "raw2", body: "", contentType: "text/plain", date: new Date() },
    ])

    await ctx.storage.put("accountId", "aea_test1")
    await durable.alarm()

    expect(putR2).toHaveBeenCalledTimes(2)
    expect(webFetch).toHaveBeenCalledTimes(2)

    const notify1 = JSON.parse(webFetch.mock.calls[0][1].body)
    expect(notify1.agentId).toBe("ag_test1")
    expect(notify1.from).toBe("alice@example.com")
    expect(notify1.subject).toBe("Hi")
    expect(notify1.isWhitelisted).toBe(true)

    expect(mockUpdateEmailAccount).toHaveBeenCalled()
    expect(ctx.storage.setAlarm).toHaveBeenCalled()
  })
})

// ─── T4: whitelist filtering ───

describe("alarm — whitelist filtering", () => {
  it("passes isWhitelisted=true for whitelisted sender", async () => {
    const { durable, ctx, webFetch } = createDO()
    mockSearchEmails.mockResolvedValue([1])
    mockFetchEmails.mockResolvedValue([
      { from: "friend@example.com", to: "user@gmail.com", subject: "Hi", messageID: "", raw: "raw", body: "", contentType: "text/plain", date: new Date() },
    ])
    mockIsWhitelisted.mockResolvedValue(true)

    await ctx.storage.put("accountId", "aea_test1")
    await durable.alarm()

    const notify = JSON.parse(webFetch.mock.calls[0][1].body)
    expect(notify.isWhitelisted).toBe(true)
  })

  it("passes isWhitelisted=false for non-whitelisted sender", async () => {
    const { durable, ctx, webFetch } = createDO()
    mockSearchEmails.mockResolvedValue([1])
    mockFetchEmails.mockResolvedValue([
      { from: "stranger@example.com", to: "user@gmail.com", subject: "Spam", messageID: "", raw: "raw", body: "", contentType: "text/plain", date: new Date() },
    ])
    mockIsWhitelisted.mockResolvedValue(false)

    await ctx.storage.put("accountId", "aea_test1")
    await durable.alarm()

    const notify = JSON.parse(webFetch.mock.calls[0][1].body)
    expect(notify.isWhitelisted).toBe(false)
  })
})

// ─── T5: connection failure & backoff ───

describe("alarm — connection failure & backoff", () => {
  it("sets error status and schedules with backoff on connection failure", async () => {
    const { durable, ctx } = createDO()
    mockConnect.mockRejectedValueOnce(new Error("Connection timeout"))

    await ctx.storage.put("accountId", "aea_test1")
    await durable.alarm()

    expect(mockUpdateEmailAccount).toHaveBeenCalledWith(
      expect.anything(), "aea_test1", "ws_test1",
      expect.objectContaining({ status: "error", errorMessage: expect.stringContaining("Connection timeout") })
    )
    expect(ctx.storage.setAlarm).toHaveBeenCalled()
  })
})

// ─── T6: auth failure ───

describe("alarm — auth failure", () => {
  it("stops polling on authentication error", async () => {
    const { durable, ctx } = createDO()
    mockConnect.mockResolvedValueOnce(undefined)
    mockSelectFolder.mockRejectedValueOnce(new Error("Authentication failed"))

    await ctx.storage.put("accountId", "aea_test1")
    await durable.alarm()

    expect(mockUpdateEmailAccount).toHaveBeenCalledWith(
      expect.anything(), "aea_test1", "ws_test1",
      expect.objectContaining({ status: "error", errorMessage: expect.stringContaining("Authentication") })
    )
    expect(ctx.storage.deleteAlarm).toHaveBeenCalled()
  })
})

// ─── T7: no new emails ───

describe("alarm — no new emails", () => {
  it("reschedules without fetching when SEARCH returns empty", async () => {
    const { durable, ctx, putR2, webFetch } = createDO()
    mockSearchEmails.mockResolvedValue([])

    await ctx.storage.put("accountId", "aea_test1")
    await durable.alarm()

    expect(mockFetchEmails).not.toHaveBeenCalled()
    expect(putR2).not.toHaveBeenCalled()
    expect(webFetch).not.toHaveBeenCalled()
    expect(ctx.storage.setAlarm).toHaveBeenCalled()
    expect(mockUpdateEmailAccount).toHaveBeenCalledWith(
      expect.anything(), "aea_test1", "ws_test1",
      expect.objectContaining({ status: "active" })
    )
  })
})

// ─── T8: fetch() routing ───

describe("fetch() routing", () => {
  it("POST /start sets accountId and schedules alarm", async () => {
    const { durable, ctx } = createDO()
    const res = await durable.fetch(new Request("http://internal/start", {
      method: "POST",
      body: JSON.stringify({ accountId: "aea_test1" }),
    }))
    expect(res.status).toBe(200)
    expect(await ctx.storage.get("accountId")).toBe("aea_test1")
    expect(ctx.storage.setAlarm).toHaveBeenCalled()
  })

  it("POST /stop cancels alarm and clears storage", async () => {
    const { durable, ctx } = createDO()
    await ctx.storage.put("accountId", "aea_test1")
    const res = await durable.fetch(new Request("http://internal/stop", { method: "POST" }))
    expect(res.status).toBe(200)
    expect(ctx.storage.deleteAlarm).toHaveBeenCalled()
    expect(ctx.storage.deleteAll).toHaveBeenCalled()
  })

  it("POST /sync triggers immediate poll", async () => {
    const { durable, ctx } = createDO()
    await ctx.storage.put("accountId", "aea_test1")
    const res = await durable.fetch(new Request("http://internal/sync", { method: "POST" }))
    expect(res.status).toBe(200)
    expect(mockSearchEmails).toHaveBeenCalled()
  })

  it("GET /status returns account status", async () => {
    const { durable, ctx } = createDO()
    await ctx.storage.put("accountId", "aea_test1")
    mockGetEmailAccount.mockResolvedValue({ status: "active", lastSyncedAt: "2025-01-01", errorMessage: "" })
    const res = await durable.fetch(new Request("http://internal/status", { method: "GET" }))
    const json = await res.json() as any
    expect(json.status).toBe("active")
    expect(json.lastSyncedAt).toBe("2025-01-01")
  })

  it("GET /status returns stopped when no accountId", async () => {
    const { durable } = createDO()
    const res = await durable.fetch(new Request("http://internal/status", { method: "GET" }))
    const json = await res.json() as any
    expect(json.status).toBe("stopped")
  })
})

// ─── T9: lifecycle ───

describe("lifecycle", () => {
  it("stops polling when account is deleted from DB", async () => {
    const { durable, ctx } = createDO()
    mockGetEmailAccount.mockResolvedValue(null)
    await ctx.storage.put("accountId", "aea_test1")

    await durable.alarm()

    expect(ctx.storage.deleteAlarm).toHaveBeenCalled()
    expect(ctx.storage.deleteAll).toHaveBeenCalled()
    expect(mockSearchEmails).not.toHaveBeenCalled()
  })
})
