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

const { mockConnect, mockSelect, mockLogout, mockCommand, MockImapAuthError } = vi.hoisted(() => {
  class _MockImapAuthError extends Error {
    constructor(msg: string) { super(msg); this.name = "ImapAuthError" }
  }
  return {
    mockConnect: vi.fn().mockResolvedValue(undefined),
    mockSelect: vi.fn().mockResolvedValue({ exists: 5 }),
    mockLogout: vi.fn().mockResolvedValue(undefined),
    mockCommand: vi.fn<(tag: string, cmd: string) => Promise<string>>(),
    MockImapAuthError: _MockImapAuthError,
  }
})

vi.mock("./lib/imap-client", () => ({
  ImapClient: class {
    connect = mockConnect
    select = mockSelect
    logout = mockLogout
    command = mockCommand
  },
  ImapAuthError: MockImapAuthError,
  ImapError: class extends Error {
    constructor(msg: string) { super(msg); this.name = "ImapError" }
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
const mockBuildWhitelistSet = vi.fn()

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
    createDb: () => ({}),
    createLogger: () => noopLogger,
    parseIcs: real.parseIcs,
    extractAttachmentMeta: real.extractAttachmentMeta,
    DEV_WEB_URL: "http://localhost:3000",
    queries: {
      emailAccount: {
        getEmailAccount: (...args: any[]) => mockGetEmailAccount(...args),
        getEmailAccountById: (...args: any[]) => mockGetEmailAccount(...args),
        updateEmailAccount: (...args: any[]) => mockUpdateEmailAccount(...args),
      },
      whitelist: {
        isWhitelisted: (...args: any[]) => mockIsWhitelisted(...args),
        buildWhitelistSet: (...args: any[]) => mockBuildWhitelistSet(...args),
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
      getAlarm: vi.fn(async () => alarm),
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
  mockIsWhitelisted.mockReturnValue(true)
  mockBuildWhitelistSet.mockResolvedValue({ check: (email: string) => mockIsWhitelisted(email) })
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

    mockCommand
      .mockResolvedValueOnce("* SEARCH 101 102\r\nS1 OK UID SEARCH completed\r\n")
      .mockResolvedValueOnce(buildFetchResponse(101, RAW_EMAIL_1))
      .mockResolvedValueOnce(buildFetchResponse(102, RAW_EMAIL_2))

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
    mockCommand.mockResolvedValueOnce("* SEARCH\r\nS1 OK UID SEARCH completed\r\n")
    mockGetEmailAccount.mockResolvedValue({ ...ACCOUNT, lastSyncedUid: "0" })

    await ctx.storage.put("accountId", "aea_test1")
    await durable.alarm()

    const [tag, cmd] = mockCommand.mock.calls[0]!
    expect(tag).toBe("S1")
    expect(cmd).toMatch(/UID SEARCH SINCE \d{1,2}-\w{3}-\d{4}/)
  })

  it("filters out UIDs <= lastSyncedUid from SEARCH results", async () => {
    const { durable, ctx, putR2 } = createDO()
    mockCommand
      .mockResolvedValueOnce("* SEARCH 100 101 102\r\nS1 OK UID SEARCH completed\r\n")
      .mockResolvedValueOnce(buildFetchResponse(101, RAW_EMAIL_1))
      .mockResolvedValueOnce(buildFetchResponse(102, RAW_EMAIL_2))
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
    mockCommand
      .mockResolvedValueOnce("* SEARCH 50\r\nS1 OK UID SEARCH completed\r\n")
      .mockResolvedValueOnce(buildFetchResponse(50, RAW_EMAIL_1))
    mockGetEmailAccount.mockResolvedValue({ ...ACCOUNT, lastSyncedUid: "0" })
    mockIsWhitelisted.mockReturnValue(true)
    mockBuildWhitelistSet.mockResolvedValue({ check: () => true })

    await ctx.storage.put("accountId", "aea_test1")
    await durable.alarm()

    const notify = JSON.parse(webFetch.mock.calls[0][1].body)
    expect(notify.isWhitelisted).toBe(true)
  })

  it("passes isWhitelisted=false for non-whitelisted sender", async () => {
    const { durable, ctx, webFetch } = createDO()
    mockCommand
      .mockResolvedValueOnce("* SEARCH 50\r\nS1 OK UID SEARCH completed\r\n")
      .mockResolvedValueOnce(buildFetchResponse(50, RAW_EMAIL_1))
    mockGetEmailAccount.mockResolvedValue({ ...ACCOUNT, lastSyncedUid: "0" })
    mockIsWhitelisted.mockReturnValue(false)
    mockBuildWhitelistSet.mockResolvedValue({ check: () => false })

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
  it("retries with backoff on authentication error instead of stopping", async () => {
    const { durable, ctx } = createDO()
    mockConnect.mockRejectedValueOnce(new MockImapAuthError("IMAP A1 failed: A1 NO [AUTHENTICATIONFAILED]"))

    await ctx.storage.put("accountId", "aea_test1")
    await durable.alarm()

    expect(mockUpdateEmailAccount).toHaveBeenCalledWith(
      expect.anything(), "aea_test1", "ws_test1",
      expect.objectContaining({ status: "error", errorMessage: expect.stringContaining("AUTHENTICATIONFAILED") })
    )
    expect(ctx.storage.setAlarm).toHaveBeenCalled()
    expect(ctx.storage.deleteAlarm).not.toHaveBeenCalled()
  })
})

// ─── No new emails ───

describe("alarm — no new emails", () => {
  it("reschedules without fetching when UID SEARCH returns empty", async () => {
    const { durable, ctx, putR2, webFetch } = createDO()
    mockCommand.mockResolvedValueOnce("* SEARCH\r\nS1 OK UID SEARCH completed\r\n")
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

// ─── IMAP command error responses ───

describe("alarm — IMAP command error responses", () => {
  it("throws and triggers backoff when IMAP SEARCH returns NO", async () => {
    const { durable, ctx } = createDO()
    mockCommand.mockRejectedValueOnce(new Error("IMAP S1 failed: S1 NO [NONEXISTENT] Mailbox not found"))
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
    mockCommand.mockRejectedValueOnce(new Error("IMAP stream ended without tagged response for S1"))
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
    mockCommand.mockResolvedValueOnce("* SEARCH\r\nS1 OK UID SEARCH completed\r\n")
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

// ─── Alarm resilience ───

describe("alarm — resilience", () => {
  it("reschedules alarm even when poll times out", async () => {
    vi.useFakeTimers()
    try {
      const { durable, ctx } = createDO()
      await ctx.storage.put("accountId", "aea_test1")
      mockGetEmailAccount.mockResolvedValue({ ...ACCOUNT })
      // Simulate a poll that never resolves (hangs forever)
      mockConnect.mockImplementation(() => new Promise(() => {}))

      const alarmPromise = durable.alarm()
      await vi.advanceTimersByTimeAsync(30_000)
      await alarmPromise

      // Despite poll hanging, alarm must be rescheduled
      expect(ctx.storage.getAlarm).toHaveBeenCalled()
      expect(ctx.storage.setAlarm).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it("reschedules alarm when DB query throws in pollImap", async () => {
    const { durable, ctx } = createDO()
    await ctx.storage.put("accountId", "aea_test1")
    // First call in alarm() succeeds, second call in pollImap() throws
    mockGetEmailAccount
      .mockResolvedValueOnce({ ...ACCOUNT })
      .mockRejectedValueOnce(new Error("D1 unavailable"))

    await durable.alarm()

    expect(ctx.storage.setAlarm).toHaveBeenCalled()
  })
})
