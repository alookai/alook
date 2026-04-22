import { describe, it, expect, vi, beforeEach } from "vitest"

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

const { mockConnect, mockSelectFolder, mockLogout } = vi.hoisted(() => ({
  mockConnect: vi.fn().mockResolvedValue(undefined),
  mockSelectFolder: vi.fn().mockResolvedValue({ exists: 5 }),
  mockLogout: vi.fn().mockResolvedValue(true),
}))

const { mockWriterWrite, mockReaderRead } = vi.hoisted(() => ({
  mockWriterWrite: vi.fn().mockResolvedValue(undefined),
  mockReaderRead: vi.fn<() => Promise<{ value: Uint8Array; done: boolean }>>(),
}))

vi.mock("cf-imap", () => ({
  CFImap: class {
    connect = mockConnect
    selectFolder = mockSelectFolder
    logout = mockLogout
    writer = { write: mockWriterWrite }
    reader = { read: mockReaderRead }
  },
}))

const { mockPostalParse } = vi.hoisted(() => ({
  mockPostalParse: vi.fn(),
}))

vi.mock("postal-mime", () => ({
  default: { parse: mockPostalParse },
}))

let nanoidCounter = 0
vi.mock("nanoid", () => ({
  nanoid: (len?: number) => `mock-${++nanoidCounter}`,
}))

vi.mock("@alook/shared/crypto", () => ({
  encrypt: (val: string) => `encrypted:${val}`,
  decrypt: (val: string) => `decrypted:${val}`,
}))

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

const encoder = new TextEncoder()

/** Queue raw IMAP response strings for the mock reader. */
function queueReaderResponses(...responses: string[]) {
  let idx = 0
  mockReaderRead.mockImplementation(async () => {
    if (idx < responses.length) {
      return { value: encoder.encode(responses[idx++]), done: false }
    }
    return { value: new Uint8Array(), done: true }
  })
}

function buildFetchResponse(uid: number, rawEmail: string): string {
  return `* 1 FETCH (UID ${uid} BODY[] {${rawEmail.length}}\r\n${rawEmail}\r\n)\r\nF${uid} OK UID FETCH completed\r\n`
}

const RAW_EMAIL_1 = "From: alice@example.com\r\nSubject: Hi\r\nMessage-ID: <msg1>\r\n\r\nHello"
const RAW_EMAIL_2 = "From: bob@example.com\r\nSubject: Hey\r\nMessage-ID: <msg2>\r\n\r\nWorld"

beforeEach(() => {
  nanoidCounter = 0
  vi.clearAllMocks()
  mockGetEmailAccount.mockResolvedValue({ ...ACCOUNT })
  mockUpdateEmailAccount.mockResolvedValue(undefined)
  mockIsWhitelisted.mockResolvedValue(true)
  mockPostalParse.mockResolvedValue({
    from: { name: "", address: "alice@example.com" },
    subject: "Hi",
    messageId: "<msg1>",
    inReplyTo: "",
    references: "",
  })
})

// ─── Normal flow with UID tracking ───

describe("alarm — normal UID-based flow", () => {
  it("searches by UID, fetches, stores in R2, notifies web, and updates lastSyncedUid", async () => {
    const { durable, ctx, putR2, webFetch } = createDO()

    mockPostalParse
      .mockResolvedValueOnce({ from: { name: "", address: "alice@example.com" }, subject: "Hi", messageId: "<msg1>", inReplyTo: "", references: "" })
      .mockResolvedValueOnce({ from: { name: "", address: "bob@example.com" }, subject: "Hey", messageId: "<msg2>", inReplyTo: "", references: "" })

    queueReaderResponses(
      "* SEARCH 101 102\r\nS1 OK UID SEARCH completed\r\n",
      buildFetchResponse(101, RAW_EMAIL_1),
      buildFetchResponse(102, RAW_EMAIL_2),
    )

    mockGetEmailAccount.mockResolvedValue({ ...ACCOUNT, lastSyncedUid: "100" })
    await ctx.storage.put("accountId", "aea_test1")
    await durable.alarm()

    expect(putR2).toHaveBeenCalledTimes(2)
    expect(webFetch).toHaveBeenCalledTimes(2)

    const notify1 = JSON.parse(webFetch.mock.calls[0][1].body)
    expect(notify1.agentId).toBe("ag_test1")
    expect(notify1.from).toBe("alice@example.com")
    expect(notify1.subject).toBe("Hi")
    expect(notify1.isWhitelisted).toBe(true)
    expect(notify1.messageId).toBe("<msg1>")

    const notify2 = JSON.parse(webFetch.mock.calls[1][1].body)
    expect(notify2.from).toBe("bob@example.com")
    expect(notify2.subject).toBe("Hey")

    expect(mockUpdateEmailAccount).toHaveBeenCalledWith(
      expect.anything(), "aea_test1", "ws_test1",
      expect.objectContaining({ status: "active", lastSyncedUid: "102" })
    )
    expect(ctx.storage.setAlarm).toHaveBeenCalled()
    expect(mockLogout).toHaveBeenCalled()
  })

  it("uses SINCE filter for first sync (lastSyncedUid=0)", async () => {
    const { durable, ctx } = createDO()
    queueReaderResponses("* SEARCH\r\nS1 OK UID SEARCH completed\r\n")
    mockGetEmailAccount.mockResolvedValue({ ...ACCOUNT, lastSyncedUid: "0" })

    await ctx.storage.put("accountId", "aea_test1")
    await durable.alarm()

    const writeCall = mockWriterWrite.mock.calls[0][0]
    const cmd = new TextDecoder().decode(writeCall)
    expect(cmd).toMatch(/S1 UID SEARCH SINCE \d{1,2}-\w{3}-\d{4}/)
  })

  it("filters out UIDs <= lastSyncedUid from SEARCH results", async () => {
    const { durable, ctx, putR2 } = createDO()
    // UID SEARCH UID 101:* might return UID 100 on some servers
    queueReaderResponses(
      "* SEARCH 100 101 102\r\nS1 OK UID SEARCH completed\r\n",
      buildFetchResponse(101, RAW_EMAIL_1),
      buildFetchResponse(102, RAW_EMAIL_2),
    )
    mockGetEmailAccount.mockResolvedValue({ ...ACCOUNT, lastSyncedUid: "100" })

    await ctx.storage.put("accountId", "aea_test1")
    await durable.alarm()

    // Only 101 and 102 should be fetched, not 100
    expect(putR2).toHaveBeenCalledTimes(2)
  })
})

// ─── Whitelist filtering ───

describe("alarm — whitelist filtering", () => {
  it("passes isWhitelisted=true for whitelisted sender", async () => {
    const { durable, ctx, webFetch } = createDO()
    queueReaderResponses(
      "* SEARCH 50\r\nS1 OK UID SEARCH completed\r\n",
      buildFetchResponse(50, RAW_EMAIL_1),
    )
    mockGetEmailAccount.mockResolvedValue({ ...ACCOUNT, lastSyncedUid: "0" })
    mockIsWhitelisted.mockResolvedValue(true)

    await ctx.storage.put("accountId", "aea_test1")
    await durable.alarm()

    const notify = JSON.parse(webFetch.mock.calls[0][1].body)
    expect(notify.isWhitelisted).toBe(true)
  })

  it("passes isWhitelisted=false for non-whitelisted sender", async () => {
    const { durable, ctx, webFetch } = createDO()
    queueReaderResponses(
      "* SEARCH 50\r\nS1 OK UID SEARCH completed\r\n",
      buildFetchResponse(50, RAW_EMAIL_1),
    )
    mockGetEmailAccount.mockResolvedValue({ ...ACCOUNT, lastSyncedUid: "0" })
    mockIsWhitelisted.mockResolvedValue(false)

    await ctx.storage.put("accountId", "aea_test1")
    await durable.alarm()

    const notify = JSON.parse(webFetch.mock.calls[0][1].body)
    expect(notify.isWhitelisted).toBe(false)
  })
})

// ─── Connection failure & backoff ───

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

// ─── Auth failure ───

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

// ─── No new emails ───

describe("alarm — no new emails", () => {
  it("reschedules without fetching when UID SEARCH returns empty", async () => {
    const { durable, ctx, putR2, webFetch } = createDO()
    queueReaderResponses("* SEARCH\r\nS1 OK UID SEARCH completed\r\n")
    mockGetEmailAccount.mockResolvedValue({ ...ACCOUNT, lastSyncedUid: "50" })

    await ctx.storage.put("accountId", "aea_test1")
    await durable.alarm()

    expect(putR2).not.toHaveBeenCalled()
    expect(webFetch).not.toHaveBeenCalled()
    expect(ctx.storage.setAlarm).toHaveBeenCalled()
    expect(mockUpdateEmailAccount).toHaveBeenCalledWith(
      expect.anything(), "aea_test1", "ws_test1",
      expect.objectContaining({ status: "active" })
    )
  })
})

// ─── Multi-chunk and error responses ───

describe("alarm — IMAP response edge cases", () => {
  it("handles FETCH response split across multiple TCP reads", async () => {
    const { durable, ctx, putR2 } = createDO()
    const rawEmail = RAW_EMAIL_1
    const fullFetch = buildFetchResponse(101, rawEmail)
    const mid = Math.floor(fullFetch.length / 2)

    queueReaderResponses(
      "* SEARCH 101\r\nS1 OK UID SEARCH completed\r\n",
      fullFetch.substring(0, mid),
      fullFetch.substring(mid),
    )
    mockGetEmailAccount.mockResolvedValue({ ...ACCOUNT, lastSyncedUid: "100" })

    await ctx.storage.put("accountId", "aea_test1")
    await durable.alarm()

    expect(putR2).toHaveBeenCalledTimes(1)
  })

  it("throws and triggers backoff when IMAP SEARCH returns NO", async () => {
    const { durable, ctx } = createDO()
    queueReaderResponses("S1 NO [NONEXISTENT] Mailbox not found\r\n")
    mockGetEmailAccount.mockResolvedValue({ ...ACCOUNT, lastSyncedUid: "50" })

    await ctx.storage.put("accountId", "aea_test1")
    await durable.alarm()

    expect(mockUpdateEmailAccount).toHaveBeenCalledWith(
      expect.anything(), "aea_test1", "ws_test1",
      expect.objectContaining({ status: "error", errorMessage: expect.stringContaining("S1") })
    )
    expect(ctx.storage.setAlarm).toHaveBeenCalled()
  })

  it("throws and triggers backoff when IMAP stream ends prematurely", async () => {
    const { durable, ctx } = createDO()
    // Stream ends without a tagged response
    mockReaderRead.mockResolvedValueOnce({ value: encoder.encode("* SEARCH 101\r\n"), done: false })
    mockReaderRead.mockResolvedValueOnce({ value: new Uint8Array(), done: true })
    mockGetEmailAccount.mockResolvedValue({ ...ACCOUNT, lastSyncedUid: "100" })

    await ctx.storage.put("accountId", "aea_test1")
    await durable.alarm()

    expect(mockUpdateEmailAccount).toHaveBeenCalledWith(
      expect.anything(), "aea_test1", "ws_test1",
      expect.objectContaining({ status: "error", errorMessage: expect.stringContaining("stream ended") })
    )
  })
})

// ─── fetch() routing ───

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
    queueReaderResponses("* SEARCH\r\nS1 OK UID SEARCH completed\r\n")
    await ctx.storage.put("accountId", "aea_test1")
    const res = await durable.fetch(new Request("http://internal/sync", { method: "POST" }))
    expect(res.status).toBe(200)
    expect(mockConnect).toHaveBeenCalled()
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

// ─── Lifecycle ───

describe("lifecycle", () => {
  it("stops polling when account is deleted from DB", async () => {
    const { durable, ctx } = createDO()
    mockGetEmailAccount.mockResolvedValue(null)
    await ctx.storage.put("accountId", "aea_test1")

    await durable.alarm()

    expect(ctx.storage.deleteAlarm).toHaveBeenCalled()
    expect(ctx.storage.deleteAll).toHaveBeenCalled()
    expect(mockConnect).not.toHaveBeenCalled()
  })
})
