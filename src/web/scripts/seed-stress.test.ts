import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { parseSeedArgs, runSeedStress, mergeSetCookies, extractSetCookies, RatePacer } from "./seed-stress"

vi.mock("../src/lib/logger", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

describe("parseSeedArgs", () => {
  it("applies breadth-heavy, shallow-message defaults", () => {
    const opts = parseSeedArgs([])
    expect(opts.servers).toBe(30)
    expect(opts.channels).toBe(40)
    expect(opts.messages).toBe(60)
    expect(opts.serverUrl).toBe("http://localhost:3000")
    expect(opts.owner).toBe("perf-seed")
  })

  it("overrides via flags", () => {
    const opts = parseSeedArgs(["--servers=3", "--channels=5", "--messages=10", "--owner=x"])
    expect(opts).toMatchObject({ servers: 3, channels: 5, messages: 10, owner: "x" })
  })

  it("rejects non-integer / negative numbers", () => {
    expect(() => parseSeedArgs(["--servers=abc"])).toThrow(/servers/)
    expect(() => parseSeedArgs(["--messages=-1"])).toThrow(/messages/)
  })
})

describe("cookie jar — better-auth two-cookie handshake", () => {
  it("MERGES cookies across responses instead of replacing (the 401 regression)", () => {
    const jar = new Map<string, string>()
    // Response 1: sign-in sets both token + data.
    mergeSetCookies(jar, [
      "better-auth.session_token=TOK; Path=/; HttpOnly",
      "better-auth.session_data=DATA; Path=/; HttpOnly",
    ])
    // Response 2: a later call re-emits ONLY session_data. A replace-semantics
    // jar would drop the token here and 401 the next request.
    mergeSetCookies(jar, ["better-auth.session_data=DATA2; Path=/"])
    expect(jar.get("better-auth.session_token")).toBe("TOK")
    expect(jar.get("better-auth.session_data")).toBe("DATA2")
  })

  it("deletes a cookie when set to empty value", () => {
    const jar = new Map<string, string>([["x", "1"]])
    mergeSetCookies(jar, ["x=; Path=/; Max-Age=0"])
    expect(jar.has("x")).toBe(false)
  })

  it("extractSetCookies prefers getSetCookie() (undici) over the joined header", () => {
    const res = {
      headers: {
        getSetCookie: () => ["a=1; Path=/", "b=2; Path=/"],
        get: () => "a=1, b=2",
      },
    } as unknown as Response
    expect(extractSetCookies(res)).toEqual(["a=1; Path=/", "b=2; Path=/"])
  })
})

describe("RatePacer — proactive throttle under the per-user msgSend limit", () => {
  it("admits up to `max` within the window without blocking, then blocks", async () => {
    // Fixed clock: no time passes, so after `max` acquisitions the next would
    // block. We assert the first `max` resolve immediately.
    const pacer = new RatePacer(3, 10_000)
    const clock = () => 1000
    await pacer.acquire(clock)
    await pacer.acquire(clock)
    await pacer.acquire(clock)
    // A 4th at the same instant must not resolve synchronously — race it
    // against a microtask and confirm it hasn't settled.
    let settled = false
    const pending = pacer.acquire(clock).then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    // Not awaiting `pending` (it would sleep on the real timer); the assertion
    // above already proves it blocked.
    void pending
  })

  it("evicts stamps older than the window so slots free up over time", async () => {
    const pacer = new RatePacer(2, 10_000)
    let t = 0
    const clock = () => t
    await pacer.acquire(clock) // t=0
    await pacer.acquire(clock) // t=0, bucket full
    t = 10_001 // both stamps now older than the window
    let settled = false
    await pacer.acquire(clock).then(() => { settled = true })
    expect(settled).toBe(true)
  })
})

// --- Idempotency + manifest via mocked fetch ---

interface FetchCall {
  url: string
  method: string
  body?: unknown
}

function installFetchMock(handlers: {
  existingServers?: Array<{ id: string; name: string }>
  existingChannels?: Array<{ id: string; name: string }>
  existingMessageCount?: number
  /** Return 429 (with tiny Retry-After) for the first N message POSTs. */
  messageFailWith429Times?: number
}): { calls: FetchCall[] } {
  const calls: FetchCall[] = []
  const existingServers = handlers.existingServers ?? []
  const existingChannels = handlers.existingChannels ?? []
  const msgCount = handlers.existingMessageCount ?? 0
  let remaining429 = handlers.messageFailWith429Times ?? 0

  const jsonRes = (data: unknown): Response =>
    ({ ok: true, status: 200, headers: { get: () => null }, json: async () => data }) as unknown as Response
  const rateLimited = (): Response =>
    ({
      ok: false,
      status: 429,
      headers: { get: (h: string) => (h === "Retry-After" ? "0.01" : null) },
      json: async () => ({}),
    }) as unknown as Response

  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET"
    const body = init?.body ? JSON.parse(init.body as string) : undefined
    calls.push({ url, method, body })

    if (url.includes("/api/auth/sign-in/email")) return jsonRes({})
    if (url.endsWith("/api/ws/token")) return jsonRes({ userId: "user-seed-1" })
    if (url.endsWith("/api/community/servers") && method === "GET") {
      return jsonRes({ servers: existingServers })
    }
    if (url.endsWith("/api/community/servers") && method === "POST") {
      return jsonRes({ server: { id: "new-server" } })
    }
    if (/\/api\/community\/servers\/[^/]+$/.test(url) && method === "GET") {
      return jsonRes({ categories: [{ channels: existingChannels }] })
    }
    if (/\/channels$/.test(url) && method === "POST") {
      return jsonRes({ channel: { id: "new-channel" } })
    }
    if (/\/messages\?limit=100/.test(url) && method === "GET") {
      return jsonRes({ messages: new Array(msgCount).fill({}), hasMore: false })
    }
    if (/\/messages$/.test(url) && method === "POST") {
      if (remaining429 > 0) {
        remaining429--
        return rateLimited()
      }
      return jsonRes({ message: { id: "m" } })
    }
    throw new Error(`unhandled ${method} ${url}`)
  })
  vi.stubGlobal("fetch", fetchMock)
  return { calls }
}

beforeEach(() => vi.unstubAllGlobals())
afterEach(() => vi.unstubAllGlobals())

describe("runSeedStress — idempotency", () => {
  it("skips re-creating an existing server, matching the SLUGIFIED stored name", async () => {
    // The route stores the slugified name ("Load Test 01" -> "Load-Test-01").
    // Idempotency must match that, not the raw input.
    const { calls } = installFetchMock({
      existingServers: [{ id: "srv-existing", name: "Load-Test-01" }],
      existingChannels: [{ id: "ch-existing", name: "channel-01" }],
      existingMessageCount: 100,
    })
    const manifest = await runSeedStress({
      servers: 1,
      channels: 1,
      messages: 60,
      serverUrl: "http://localhost:3000",
      owner: "perf-seed",
    })
    // No POST to create a server.
    const serverPosts = calls.filter(
      (c) => c.url.endsWith("/api/community/servers") && c.method === "POST",
    )
    expect(serverPosts).toHaveLength(0)
    expect(manifest.servers[0].id).toBe("srv-existing")
  })

  it("seeds ZERO messages when the channel already meets the target", async () => {
    const { calls } = installFetchMock({
      existingServers: [{ id: "srv-existing", name: "Load-Test-01" }],
      existingChannels: [{ id: "ch-existing", name: "channel-01" }],
      existingMessageCount: 60,
    })
    await runSeedStress({
      servers: 1,
      channels: 1,
      messages: 60,
      serverUrl: "http://localhost:3000",
      owner: "perf-seed",
    })
    const messagePosts = calls.filter((c) => /\/messages$/.test(c.url) && c.method === "POST")
    expect(messagePosts).toHaveLength(0)
  })

  it("tops up to exactly the target when the channel is below it", async () => {
    const { calls } = installFetchMock({
      existingServers: [{ id: "srv-existing", name: "Load-Test-01" }],
      existingChannels: [{ id: "ch-existing", name: "channel-01" }],
      existingMessageCount: 50,
    })
    await runSeedStress({
      servers: 1,
      channels: 1,
      messages: 60,
      serverUrl: "http://localhost:3000",
      owner: "perf-seed",
    })
    const messagePosts = calls.filter((c) => /\/messages$/.test(c.url) && c.method === "POST")
    expect(messagePosts).toHaveLength(10)
  })

  it("records the resolved owner userId in the manifest", async () => {
    installFetchMock({
      existingServers: [{ id: "srv-existing", name: "Load-Test-01" }],
      existingChannels: [{ id: "ch-existing", name: "channel-01" }],
      existingMessageCount: 60,
    })
    const manifest = await runSeedStress({
      servers: 1,
      channels: 1,
      messages: 60,
      serverUrl: "http://localhost:3000",
      owner: "perf-seed",
    })
    expect(manifest.owner).toEqual({ email: "perf-seed@alook.test", userId: "user-seed-1" })
  })

  it("retries a 429 (honoring Retry-After) instead of aborting the seed", async () => {
    const { calls } = installFetchMock({
      existingServers: [{ id: "srv-existing", name: "Load-Test-01" }],
      existingChannels: [{ id: "ch-existing", name: "channel-01" }],
      existingMessageCount: 0,
      messageFailWith429Times: 2, // first two message POSTs get rate-limited
    })
    await runSeedStress({
      servers: 1,
      channels: 1,
      messages: 1, // one message needed → 2×429 then success = 3 POSTs
      serverUrl: "http://localhost:3000",
      owner: "perf-seed",
    })
    const messagePosts = calls.filter((c) => /\/messages$/.test(c.url) && c.method === "POST")
    expect(messagePosts).toHaveLength(3) // 2 rate-limited + 1 success, no abort
  })
})
