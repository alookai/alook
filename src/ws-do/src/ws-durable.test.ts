import { describe, it, expect, vi, beforeEach } from "vitest"
import { createMockCtx, createMockWebSocket } from "./__mocks__/cf"

// --- Cloudflare Workers globals that don't exist in Node ---

// Replace the global Response with one that allows status 101 and a webSocket property
class CFResponse {
  status: number
  webSocket: unknown
  private _body: BodyInit | null
  private _headers: Headers

  constructor(body: BodyInit | null = null, init: ResponseInit & { webSocket?: unknown } = {}) {
    this._body = body
    this._headers = new Headers(init.headers)
    this.status = init.status ?? 200
    this.webSocket = (init as { webSocket?: unknown }).webSocket
  }

  async text(): Promise<string> {
    if (this._body == null) return ""
    if (typeof this._body === "string") return this._body
    return ""
  }

  async json(): Promise<unknown> {
    return JSON.parse(await this.text())
  }

  get headers() { return this._headers }
}

globalThis.Response = CFResponse as unknown as typeof Response

// WebSocketPair — creates a paired (client, server) mock
globalThis.WebSocketPair = class {
  0: ReturnType<typeof createMockWebSocket>
  1: ReturnType<typeof createMockWebSocket>
  constructor() {
    this[0] = createMockWebSocket()
    this[1] = createMockWebSocket()
  }
} as unknown as typeof WebSocketPair

// WebSocketRequestResponsePair — used for the ping/pong auto-response
globalThis.WebSocketRequestResponsePair = class {
  constructor(public request: string, public response: string) {}
} as unknown as typeof WebSocketRequestResponsePair

// --- Module mocks ---

// Mock cloudflare:workers DurableObject base class
vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: unknown
    env: unknown
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx
      this.env = env
    }
  },
}))

// Mock @alook/shared
const mockGetValidSession = vi.fn<(db: unknown, token: string) => Promise<string | null>>()
const mockGetMachineTokenByToken = vi.fn()
const mockGetLatestTokenForUser = vi.fn()
const mockGetRuntimeIdsByDaemon = vi.fn()
const mockCreateDb = vi.fn().mockReturnValue({})
const mockHashCredential = vi.fn(async (bearer: string) => `hash:${bearer}`)
const mockFindCredentialByHash = vi.fn()
const mockGetMachineByIdForUser = vi.fn()
const mockUpsertMachineByMachineId = vi.fn()
const mockToSummary = vi.fn((row: any) => ({
  id: row.id,
  hostname: row.hostname ?? "",
  displayName: row.displayName ?? row.hostname ?? "",
  platform: row.platform ?? "",
  arch: row.arch ?? "",
  osRelease: row.osRelease ?? "",
  daemonVersion: row.daemonVersion ?? "",
  lastSeenAt: row.lastSeenAt ?? null,
  status: row.lastSeenAt ? "online" : "offline",
  availableRuntimes: row.availableRuntimes ?? [],
  createdAt: row.createdAt ?? "",
  updatedAt: row.updatedAt ?? "",
}))

vi.mock("@alook/shared", () => {
  const noopLogger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => noopLogger,
  }
  // Bare-minimum safeParse stubs — the DO only calls `.safeParse(msg)` and
  // reads `.success` / `.data`. Enough to route the test frames correctly
  // without pulling in zod (which isn't a direct dep of @alook/ws-do).
  const SessionErrorFrameSchema = {
    safeParse(v: unknown) {
      const m = v as { type?: unknown; code?: unknown; agentId?: unknown; payload?: unknown }
      if (m?.type !== "session.error" || m?.code !== "runtime_not_available") {
        return { success: false } as const
      }
      return {
        success: true as const,
        data: {
          type: "session.error" as const,
          code: "runtime_not_available" as const,
          agentId: typeof m.agentId === "string" ? (m.agentId as string) : undefined,
          payload: (m.payload as Record<string, unknown> | undefined) ?? undefined,
        },
      }
    },
  }
  // Mirror the shared HostReadyMessageSchema: the daemon's ready frame must be
  // FLAT (fields at top level), not wrapped in a `ready` key. A wrapped frame
  // is rejected — regression guard against the wire-shape mismatch we hit
  // when the daemon sent `{type:"ready", ready:{...}}` while the DO expected
  // flat top-level fields.
  const HostReadyMessageSchema = {
    safeParse(v: unknown) {
      const m = v as { type?: unknown; runtimeReport?: unknown; runningAgents?: unknown }
      if (m?.type !== "ready") return { success: false } as const
      if (!Array.isArray(m?.runtimeReport)) return { success: false } as const
      const data: Record<string, unknown> = {
        type: "ready",
        runtimeReport: m.runtimeReport,
        runningAgents: Array.isArray(m.runningAgents) ? m.runningAgents : [],
      }
      for (const k of ["hostname", "platform", "arch", "osRelease", "daemonVersion"]) {
        const val = (m as Record<string, unknown>)[k]
        if (typeof val === "string") data[k] = val
      }
      return { success: true as const, data }
    },
  }
  return {
    createDb: (d1: unknown) => mockCreateDb(d1),
    createLogger: () => noopLogger,
    COMMUNITY_MACHINE_HEARTBEAT_MS: 60_000,
    COMMUNITY_MACHINE_OFFLINE_THRESHOLD_MS: 120_000,
    SessionErrorFrameSchema,
    HostReadyMessageSchema,
    queries: {
      session: { getValidSession: (db: unknown, token: string) => mockGetValidSession(db, token) },
      machineToken: {
        getMachineTokenByToken: (...a: any[]) => mockGetMachineTokenByToken(...a),
        getLatestTokenForUser: (...a: any[]) => mockGetLatestTokenForUser(...a),
      },
      runtime: { getRuntimeIdsByDaemon: (...a: any[]) => mockGetRuntimeIdsByDaemon(...a) },
      communityMachine: {
        hashCredential: (bearer: string) => mockHashCredential(bearer),
        findCredentialByHash: (...a: any[]) => mockFindCredentialByHash(...a),
        getMachineByIdForUser: (...a: any[]) => mockGetMachineByIdForUser(...a),
        upsertMachineByMachineId: (...a: any[]) => mockUpsertMachineByMachineId(...a),
        toSummary: (row: any) => mockToSummary(row),
      },
    },
  }
})

// Import after mocks
import { WebSocketDurableObject } from "./ws-durable"

const mockStubFetch = vi.fn().mockResolvedValue(new (globalThis.Response as any)(JSON.stringify({ sent: 1 })))
const mockCheckAliveFetch = vi.fn().mockResolvedValue(new (globalThis.Response as any)(JSON.stringify({ alive: true })))

function createDO() {
  const { ctx, getWebSockets, storage, store } = createMockCtx()
  const stubGet = vi.fn().mockReturnValue({ fetch: mockStubFetch })
  const env = {
    DB: {} as D1Database,
    WS_DO: {
      idFromName: vi.fn().mockReturnValue("mock-do-id"),
      get: stubGet,
    } as unknown as DurableObjectNamespace,
  }
  const durable = new WebSocketDurableObject(ctx, env)
  return { durable, ctx, getWebSockets, env, stubGet, storage, store }
}

describe("WebSocketDurableObject", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe("fetch — WebSocket upgrade", () => {
    it("returns 101 for valid WebSocket upgrade", async () => {
      const { durable } = createDO()
      const req = new Request("http://internal/?userId=u1", {
        headers: { Upgrade: "websocket" },
      })

      const res = await durable.fetch(req)

      expect(res.status).toBe(101)
      expect((res as unknown as CFResponse).webSocket).toBeDefined()
    })

    it("returns 426 for non-WebSocket request", async () => {
      const { durable } = createDO()
      const req = new Request("http://internal/")

      const res = await durable.fetch(req)

      expect(res.status).toBe(426)
    })

    it("attaches an unauthenticated ConnectionState on upgrade", async () => {
      const { durable, ctx } = createDO()
      const req = new Request("http://internal/?userId=u1", {
        headers: { Upgrade: "websocket" },
      })

      await durable.fetch(req)

      const acceptCall = (ctx.acceptWebSocket as ReturnType<typeof vi.fn>).mock.calls[0]
      const serverWs = acceptCall[0]
      expect(serverWs.deserializeAttachment()).toEqual({ type: "user", userId: "", authenticated: false })
    })
  })

  describe("fetch — broadcast", () => {
    it("sends message to all authenticated connections", async () => {
      const { durable, ctx } = createDO()

      // Set up two WebSockets: one authenticated, one not
      const wsAuth = createMockWebSocket()
      wsAuth.serializeAttachment({ type: "user", userId: "u1", authenticated: true })
      const wsUnauth = createMockWebSocket()
      wsUnauth.serializeAttachment({ type: "user", userId: "", authenticated: false })
      ;(ctx.getWebSockets as ReturnType<typeof vi.fn>).mockReturnValue([wsAuth, wsUnauth])

      const req = new Request("http://internal/broadcast", {
        method: "POST",
        body: JSON.stringify({ type: "runtime.status", daemonId: "d1", workspaceId: "w1", status: "online" }),
      })

      const res = await durable.fetch(req)

      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ sent: 1 })
      expect(wsAuth.send).toHaveBeenCalledWith(
        JSON.stringify({ type: "runtime.status", daemonId: "d1", workspaceId: "w1", status: "online" })
      )
      expect(wsUnauth.send).not.toHaveBeenCalled()
    })

    it("returns sent: 0 when no connections exist", async () => {
      const { durable, ctx } = createDO()
      ;(ctx.getWebSockets as ReturnType<typeof vi.fn>).mockReturnValue([])

      const req = new Request("http://internal/broadcast", {
        method: "POST",
        body: '{"type":"test"}',
      })

      const res = await durable.fetch(req)

      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ sent: 0 })
    })

    it("skips connections that throw on send (already closed)", async () => {
      const { durable, ctx } = createDO()

      const wsOpen = createMockWebSocket(WebSocket.OPEN)
      wsOpen.serializeAttachment({ type: "user", userId: "u1", authenticated: true })
      const wsClosed = createMockWebSocket(WebSocket.CLOSED)
      wsClosed.serializeAttachment({ type: "user", userId: "u1", authenticated: true })
      wsClosed.send.mockImplementation(() => { throw new Error("Connection closed") })
      ;(ctx.getWebSockets as ReturnType<typeof vi.fn>).mockReturnValue([wsOpen, wsClosed])

      const req = new Request("http://internal/broadcast", {
        method: "POST",
        body: '{"type":"test"}',
      })

      const res = await durable.fetch(req)

      expect(wsOpen.send).toHaveBeenCalled()
      expect(wsClosed.send).toHaveBeenCalled()
      expect(await res.json()).toEqual({ sent: 1 })
    })
  })

  describe("webSocketMessage — auth flow", () => {
    it("authenticates with valid token and sends auth.ok", async () => {
      const { durable } = createDO()
      mockGetValidSession.mockResolvedValue("user-42")

      const ws = createMockWebSocket()
      ws.serializeAttachment({ type: "user", userId: "", authenticated: false })

      await durable.webSocketMessage(ws as any, JSON.stringify({ type: "auth", token: "valid-token" }))

      expect(mockGetValidSession).toHaveBeenCalledWith({}, "valid-token")
      expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: "auth.ok" }))
      expect(ws.deserializeAttachment()).toEqual({ type: "user", userId: "user-42", authenticated: true })
    })

    it("closes with 1008 on invalid token", async () => {
      const { durable } = createDO()
      mockGetValidSession.mockResolvedValue(null)

      const ws = createMockWebSocket()
      ws.serializeAttachment({ type: "user", userId: "", authenticated: false })

      await durable.webSocketMessage(ws as any, JSON.stringify({ type: "auth", token: "bad" }))

      expect(ws.close).toHaveBeenCalledWith(1008, "Unauthorized")
      expect(ws.send).not.toHaveBeenCalled()
    })

    it("closes with 1008 when auth message has no token", async () => {
      const { durable } = createDO()

      const ws = createMockWebSocket()
      ws.serializeAttachment({ type: "user", userId: "", authenticated: false })

      await durable.webSocketMessage(ws as any, JSON.stringify({ type: "auth" }))

      expect(ws.close).toHaveBeenCalledWith(1008, "Unauthorized")
      expect(ws.send).not.toHaveBeenCalled()
      expect(mockGetValidSession).not.toHaveBeenCalled()
    })

    it("closes with 1008 when auth message has empty string token", async () => {
      const { durable } = createDO()

      const ws = createMockWebSocket()
      ws.serializeAttachment({ type: "user", userId: "", authenticated: false })

      await durable.webSocketMessage(ws as any, JSON.stringify({ type: "auth", token: "" }))

      expect(ws.close).toHaveBeenCalledWith(1008, "Unauthorized")
      expect(ws.send).not.toHaveBeenCalled()
      expect(mockGetValidSession).not.toHaveBeenCalled()
    })

    it("closes unauthenticated connection sending non-auth message", async () => {
      const { durable } = createDO()

      const ws = createMockWebSocket()
      ws.serializeAttachment({ type: "user", userId: "", authenticated: false })

      await durable.webSocketMessage(ws as any, JSON.stringify({ type: "some-event" }))

      expect(ws.close).toHaveBeenCalledWith(1008, "Not authenticated")
    })

    it("closes with 1008 when session token is expired (getValidSession returns null)", async () => {
      const { durable } = createDO()
      mockGetValidSession.mockResolvedValue(null)

      const ws = createMockWebSocket()
      ws.serializeAttachment({ type: "user", userId: "", authenticated: false })

      await durable.webSocketMessage(ws as any, JSON.stringify({ type: "auth", token: "expired-token" }))

      expect(ws.close).toHaveBeenCalledWith(1008, "Unauthorized")
      expect(ws.send).not.toHaveBeenCalled()
      expect(ws.deserializeAttachment()).toEqual({ type: "user", userId: "", authenticated: false })
    })

    it("closes on invalid JSON", async () => {
      const { durable } = createDO()

      const ws = createMockWebSocket()

      await durable.webSocketMessage(ws as any, "not-json")

      expect(ws.close).toHaveBeenCalledWith(1008, "Invalid JSON")
    })

    it("ignores binary messages", async () => {
      const { durable } = createDO()

      const ws = createMockWebSocket()

      await durable.webSocketMessage(ws as any, new ArrayBuffer(4))

      expect(ws.close).not.toHaveBeenCalled()
      expect(ws.send).not.toHaveBeenCalled()
    })
  })

  describe("webSocketMessage — daemon auth flow", () => {
    it("rejects daemon with pending token (not yet activated)", async () => {
      const { durable } = createDO()
      mockGetMachineTokenByToken.mockResolvedValue({
        id: "mt_1", userId: "u1", status: "pending", workspaceId: null,
      })

      const ws = createMockWebSocket()
      ws.serializeAttachment({ type: "daemon", daemonId: "", userId: "", authenticated: false })

      await durable.webSocketMessage(
        ws as any,
        JSON.stringify({ type: "auth", machineToken: "al_pending123", daemonId: "my-daemon" }),
      )

      expect(ws.close).toHaveBeenCalledWith(1008, "Unauthorized")
      expect(mockGetRuntimeIdsByDaemon).not.toHaveBeenCalled()
    })

    it("authenticates daemon with active token and runtimes", async () => {
      const { durable } = createDO()
      mockGetMachineTokenByToken.mockResolvedValue({
        id: "mt_1", userId: "u1", status: "active", workspaceId: "sp_ws1",
      })
      mockGetRuntimeIdsByDaemon.mockResolvedValue(["rt_1"])

      const ws = createMockWebSocket()
      ws.serializeAttachment({ type: "daemon", daemonId: "", authenticated: false })

      await durable.webSocketMessage(
        ws as any,
        JSON.stringify({ type: "auth", machineToken: "al_active123", daemonId: "my-daemon" }),
      )

      expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: "auth.ok" }))
      expect(mockGetRuntimeIdsByDaemon).toHaveBeenCalledWith({}, "my-daemon", "sp_ws1")
    })

    it("rejects daemon with active token but no runtimes", async () => {
      const { durable } = createDO()
      mockGetMachineTokenByToken.mockResolvedValue({
        id: "mt_1", userId: "u1", status: "active", workspaceId: "sp_ws1",
      })
      mockGetRuntimeIdsByDaemon.mockResolvedValue([])

      const ws = createMockWebSocket()
      ws.serializeAttachment({ type: "daemon", daemonId: "", authenticated: false })

      await durable.webSocketMessage(
        ws as any,
        JSON.stringify({ type: "auth", machineToken: "al_noruntimes", daemonId: "my-daemon" }),
      )

      expect(ws.close).toHaveBeenCalledWith(1008, "Unauthorized")
      expect(ws.send).not.toHaveBeenCalled()
    })

    it("rejects daemon with unknown token", async () => {
      const { durable } = createDO()
      mockGetMachineTokenByToken.mockResolvedValue(null)

      const ws = createMockWebSocket()
      ws.serializeAttachment({ type: "daemon", daemonId: "", authenticated: false })

      await durable.webSocketMessage(
        ws as any,
        JSON.stringify({ type: "auth", machineToken: "al_unknown", daemonId: "my-daemon" }),
      )

      expect(ws.close).toHaveBeenCalledWith(1008, "Unauthorized")
    })

    it("rejects daemon with non-al_ prefixed token", async () => {
      const { durable } = createDO()

      const ws = createMockWebSocket()
      ws.serializeAttachment({ type: "daemon", daemonId: "", authenticated: false })

      await durable.webSocketMessage(
        ws as any,
        JSON.stringify({ type: "auth", machineToken: "bad_prefix", daemonId: "my-daemon" }),
      )

      expect(ws.close).toHaveBeenCalledWith(1008, "Unauthorized")
      expect(mockGetMachineTokenByToken).not.toHaveBeenCalled()
    })
  })

  describe("webSocketMessage — check_daemon_status (cross-DO)", () => {
    it("returns runtime.status online when daemon DO reports alive", async () => {
      const { durable, env } = createDO()
      mockGetLatestTokenForUser.mockResolvedValue({ hostname: "MyMachine.local" })

      const aliveStub = { fetch: vi.fn().mockResolvedValue(new (globalThis.Response as any)(JSON.stringify({ alive: true }))) }
      ;(env.WS_DO as any).get = vi.fn().mockReturnValue(aliveStub)

      const ws = createMockWebSocket()
      ws.serializeAttachment({ type: "user", userId: "user-42", authenticated: true })

      await durable.webSocketMessage(ws as any, JSON.stringify({ type: "check_daemon_status" }))

      expect((env.WS_DO as any).idFromName).toHaveBeenCalledWith("daemon:MyMachine.local")
      expect(ws.send).toHaveBeenCalledWith(
        JSON.stringify({ type: "runtime.status", status: "online", daemonId: "MyMachine.local" }),
      )
    })

    it("does not respond when daemon DO reports not alive", async () => {
      const { durable, env } = createDO()
      mockGetLatestTokenForUser.mockResolvedValue({ hostname: "MyMachine.local" })

      const deadStub = { fetch: vi.fn().mockResolvedValue(new (globalThis.Response as any)(JSON.stringify({ alive: false }))) }
      ;(env.WS_DO as any).get = vi.fn().mockReturnValue(deadStub)

      const ws = createMockWebSocket()
      ws.serializeAttachment({ type: "user", userId: "user-42", authenticated: true })

      await durable.webSocketMessage(ws as any, JSON.stringify({ type: "check_daemon_status" }))

      expect(ws.send).not.toHaveBeenCalled()
    })

    it("does not respond when no token/hostname found", async () => {
      const { durable } = createDO()
      mockGetLatestTokenForUser.mockResolvedValue(null)

      const ws = createMockWebSocket()
      ws.serializeAttachment({ type: "user", userId: "user-42", authenticated: true })

      await durable.webSocketMessage(ws as any, JSON.stringify({ type: "check_daemon_status" }))

      expect(ws.send).not.toHaveBeenCalled()
    })
  })

  describe("webSocketError", () => {
    it("closes with 1011", async () => {
      const { durable } = createDO()

      const ws = createMockWebSocket()

      await durable.webSocketError(ws as any, new Error("boom"))

      expect(ws.close).toHaveBeenCalledWith(1011, "Internal error")
    })
  })

  describe("community-machine — session.error overlay + optimistic clear", () => {
    beforeEach(() => {
      mockFindCredentialByHash.mockReset()
      mockGetMachineByIdForUser.mockReset()
      mockStubFetch.mockClear()
    })

    it("stashes lastRuntimeError overlay + fans out on session.error{runtime_not_available}", async () => {
      const { durable, store } = createDO()
      // Prime cached identity as if accept already ran.
      store.set("community-machine-identity", {
        userId: "u_1",
        machineId: "cm_1",
        credentialHash: "0".repeat(64),
      })
      mockGetMachineByIdForUser.mockResolvedValue({
        id: "cm_1",
        hostname: "host",
        availableRuntimes: [{ id: "codex" }],
      })

      const ws = createMockWebSocket()
      ws.serializeAttachment({
        type: "community-machine",
        machineId: "cm_1",
        userId: "u_1",
        authenticated: true,
      })

      const frame = JSON.stringify({
        type: "session.error",
        code: "runtime_not_available",
        agentId: "a1",
        payload: { requested: "gemini", available: ["codex"] },
      })
      await durable.webSocketMessage(ws as any, frame)

      const overlay = store.get("community-machine-runtime-error") as
        | { requested: string; available: string[]; at: string }
        | undefined
      expect(overlay).toBeDefined()
      expect(overlay?.requested).toBe("gemini")
      expect(overlay?.available).toEqual(["codex"])

      // Fan-out went to the user DO with the overlay attached.
      expect(mockStubFetch).toHaveBeenCalled()
      const call = mockStubFetch.mock.calls.find((c: any[]) =>
        (c[0] as Request).url.endsWith("/broadcast")
      )
      const body = JSON.parse(await (call![0] as Request).clone().text()) as {
        type: string
        machine: { lastRuntimeError?: { requested: string; available: string[] } }
      }
      expect(body.type).toBe("community:machine.updated")
      expect(body.machine.lastRuntimeError).toMatchObject({
        requested: "gemini",
        available: ["codex"],
      })
    })

    it("forceClose closes attachments and clears identity+overlay", async () => {
      const { durable, ctx, store, getWebSockets } = createDO()
      store.set("community-machine-identity", {
        userId: "u_1",
        machineId: "cm_1",
        credentialHash: "0".repeat(64),
      })
      store.set("community-machine-handle", { userId: "u_1", machineId: "cm_1" })
      store.set("community-machine-runtime-error", {
        requested: "gemini",
        available: [],
        at: "2026-07-06T00:00:00.000Z",
      })
      mockGetMachineByIdForUser.mockResolvedValue({
        id: "cm_1",
        hostname: "host",
        availableRuntimes: [],
      })

      const ws = createMockWebSocket()
      ws.serializeAttachment({
        type: "community-machine",
        machineId: "cm_1",
        userId: "u_1",
        authenticated: true,
      })
      getWebSockets.mockReturnValue([ws])

      const req = new Request("http://internal/force-close", { method: "POST" })
      const res = await durable.fetch(req)
      expect(res.status).toBe(200)
      expect(ws.send).toHaveBeenCalled()
      expect(ws.close).toHaveBeenCalledWith(1008, "Revoked")

      // Cached identity + handle + overlay all cleared.
      expect(store.get("community-machine-identity")).toBeUndefined()
      expect(store.get("community-machine-handle")).toBeUndefined()
      expect(store.get("community-machine-runtime-error")).toBeUndefined()
    })
  })

  describe("community-machine — ready frame wire shape", () => {
    beforeEach(() => {
      mockUpsertMachineByMachineId.mockReset()
      mockStubFetch.mockClear()
    })

    // Regression guard: the daemon (WsControlChannel.reportReady) spreads
    // HostReady fields at the TOP LEVEL of the frame. If it ever regresses to
    // wrapping them under `ready:{...}`, the DO would silently drop every
    // ready and `last_seen_at` would never refresh. This test drives the exact
    // shape the daemon emits.
    it("accepts a flat daemon-shaped ready frame and calls upsertMachineByMachineId", async () => {
      const { durable, store } = createDO()
      store.set("community-machine-identity", {
        userId: "u_1",
        machineId: "cm_1",
        credentialHash: "0".repeat(64),
      })
      mockUpsertMachineByMachineId.mockResolvedValue({
        machine: { id: "cm_1", hostname: "host", availableRuntimes: [{ id: "claude" }], lastSeenAt: "2026-07-06T00:00:00.000Z" },
        priorLastSeenAt: "2026-07-05T00:00:00.000Z",
        priorAvailableRuntimes: [{ id: "claude" }],
      })

      const ws = createMockWebSocket()
      ws.serializeAttachment({
        type: "community-machine",
        machineId: "cm_1",
        userId: "u_1",
        authenticated: true,
      })

      // The wire frame the daemon actually sends — see WsControlChannel.reportReady.
      const frame = JSON.stringify({
        type: "ready",
        runtimeReport: [{ id: "claude", version: "1.0.0" }],
        runningAgents: [],
        hostname: "my-mac",
        platform: "darwin",
        arch: "arm64",
        osRelease: "23.0.0",
        daemonVersion: "0.1.0",
      })
      await durable.webSocketMessage(ws as any, frame)

      expect(mockUpsertMachineByMachineId).toHaveBeenCalledTimes(1)
      const [, userId, machineId, meta] = mockUpsertMachineByMachineId.mock.calls[0]
      expect(userId).toBe("u_1")
      expect(machineId).toBe("cm_1")
      expect(meta).toMatchObject({
        hostname: "my-mac",
        platform: "darwin",
        arch: "arm64",
        osRelease: "23.0.0",
        daemonVersion: "0.1.0",
        availableRuntimes: [{ id: "claude", version: "1.0.0" }],
      })
    })

    it("silently drops a wrapped `{ready:{...}}` frame (legacy shape — regression guard)", async () => {
      const { durable, store } = createDO()
      store.set("community-machine-identity", {
        userId: "u_1",
        machineId: "cm_1",
        credentialHash: "0".repeat(64),
      })

      const ws = createMockWebSocket()
      ws.serializeAttachment({
        type: "community-machine",
        machineId: "cm_1",
        userId: "u_1",
        authenticated: true,
      })

      // The (broken) wrapped shape — schema rejects → DO drops → no DB write.
      const frame = JSON.stringify({
        type: "ready",
        ready: {
          runtimeReport: [{ id: "claude" }],
          runningAgents: [],
          hostname: "my-mac",
        },
      })
      await durable.webSocketMessage(ws as any, frame)

      expect(mockUpsertMachineByMachineId).not.toHaveBeenCalled()
    })
  })
})
