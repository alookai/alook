import { describe, it, expect, vi, beforeEach } from "vitest"
import { createMockCtx, createMockWebSocket } from "./__mocks__/cf"

// --- Cloudflare Workers globals ---

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
  async json(): Promise<unknown> { return JSON.parse(await this.text()) }
  get headers() { return this._headers }
}
globalThis.Response = CFResponse as unknown as typeof Response

// --- Module mocks ---

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

const upsertCalls: Array<{ userId: string; machineId: string; meta: any }> = []
const stub = {
  priorLastSeenAt: null as string | null,
  priorAvailableRuntimes: null as any,
  nextRow: null as any,
}

vi.mock("@alook/shared", () => {
  const noopLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child(){ return this } }
  return {
    createDb: () => ({}),
    createLogger: () => noopLogger,
    COMMUNITY_MACHINE_HEARTBEAT_MS: 60_000,
    COMMUNITY_MACHINE_OFFLINE_THRESHOLD_MS: 30_000,
    queries: {
      communityMachine: {
        upsertMachineByMachineId: async (
          _db: unknown, userId: string, machineId: string, meta: any
        ) => {
          upsertCalls.push({ userId, machineId, meta })
          if (!stub.nextRow) return null
          return {
            machine: stub.nextRow,
            priorLastSeenAt: stub.priorLastSeenAt,
            priorAvailableRuntimes: stub.priorAvailableRuntimes,
          }
        },
        toSummary: (row: any) => ({
          id: row.id,
          hostname: row.hostname,
          displayName: row.displayName,
          platform: row.platform,
          arch: row.arch,
          osRelease: row.osRelease,
          daemonVersion: row.daemonVersion,
          lastSeenAt: row.lastSeenAt,
          status: row.lastSeenAt ? "online" : "offline",
          availableRuntimes: row.availableRuntimes ?? [],
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        }),
        findActiveCredentialByBearer: async () => null,
        getMachineByIdForUser: async () => null,
        touchMachineHeartbeat: async () => null,
      },
      session: { getValidSession: async () => null },
      machineToken: { getMachineTokenByToken: async () => null, getLatestTokenForUser: async () => null },
      runtime: { getRuntimeIdsByDaemon: async () => [] },
    },
  }
})

// Import after mocks
import { WebSocketDurableObject } from "./ws-durable"

function createDO() {
  const { ctx, getWebSockets } = createMockCtx()
  const storage = new Map<string, unknown>()
  ;(ctx as any).storage = {
    getAlarm: async () => null,
    setAlarm: async (_at: number) => {},
    get: async (k: string) => storage.get(k),
    put: async (k: string, v: unknown) => { storage.set(k, v); return v },
    delete: async (k: string) => { storage.delete(k) },
  }
  const broadcastBodies: string[] = []
  const stubFetch = vi.fn(async (req: Request) => {
    broadcastBodies.push(await req.text())
    return new (globalThis.Response as any)(JSON.stringify({ sent: 1 }))
  })
  const env = {
    DB: {} as D1Database,
    WS_DO: {
      idFromName: vi.fn().mockReturnValue("mock-do-id"),
      get: vi.fn().mockReturnValue({ fetch: stubFetch }),
    } as unknown as DurableObjectNamespace,
  }
  const durable = new WebSocketDurableObject(ctx, env)
  return { durable, ctx, getWebSockets, broadcastBodies }
}

function machineRow(extra: Partial<any> = {}) {
  return {
    id: "cm_1",
    userId: "u_1",
    hostname: "host",
    displayName: "host",
    platform: "darwin",
    arch: "arm64",
    osRelease: "23",
    daemonVersion: "0.1.0",
    metadata: null,
    availableRuntimes: extra.availableRuntimes ?? [{ id: "claude" }],
    lastSeenAt: new Date().toISOString(),
    createdAt: "t",
    updatedAt: "t",
    ...extra,
  }
}

async function deliverReady(
  durable: WebSocketDurableObject,
  ready: Record<string, unknown>,
  ctx: any
) {
  const ws = createMockWebSocket()
  ws.serializeAttachment({
    type: "community-machine",
    credentialId: "cmk_abc",
    machineId: "cm_1",
    userId: "u_1",
    authenticated: true,
  })
  ctx.getWebSockets.mockReturnValue([ws])
  await durable.webSocketMessage(ws as unknown as WebSocket, JSON.stringify({ type: "ready", ready }))
  return ws
}

describe("handleCommunityMachineMessage — runtime persistence", () => {
  beforeEach(() => {
    upsertCalls.length = 0
    stub.priorLastSeenAt = null
    stub.priorAvailableRuntimes = null
    stub.nextRow = null
  })

  it("parses runtimeReport and passes typed list to upsertMachineByMachineId", async () => {
    stub.nextRow = machineRow({ availableRuntimes: [{ id: "claude", version: "1.0.0" }] })
    const { durable, ctx } = createDO()
    await deliverReady(durable, {
      hostname: "host",
      os: "darwin",
      arch: "arm64",
      runtimeReport: [{ id: "claude", version: "1.0.0" }],
    }, ctx)
    expect(upsertCalls).toHaveLength(1)
    expect(upsertCalls[0].machineId).toBe("cm_1")
    expect(upsertCalls[0].meta.availableRuntimes).toEqual([{ id: "claude", version: "1.0.0" }])
  })

  it("falls back to legacy runtimes (string[]) when runtimeReport is absent", async () => {
    stub.nextRow = machineRow({ availableRuntimes: [{ id: "claude" }] })
    const { durable, ctx } = createDO()
    await deliverReady(durable, { runtimes: ["claude"] }, ctx)
    expect(upsertCalls[0].meta.availableRuntimes).toEqual([{ id: "claude" }])
  })

  it("stores [] when neither field is provided", async () => {
    stub.nextRow = machineRow({ availableRuntimes: [] })
    const { durable, ctx } = createDO()
    await deliverReady(durable, {}, ctx)
    expect(upsertCalls[0].meta.availableRuntimes).toEqual([])
  })

  it("does NOT emit machine.created on first ready (activate route owns that event)", async () => {
    stub.priorLastSeenAt = null
    stub.nextRow = machineRow({ availableRuntimes: [{ id: "claude" }] })
    const { durable, ctx, broadcastBodies } = createDO()
    await deliverReady(durable, { runtimes: ["claude"] }, ctx)
    expect(broadcastBodies.some((b) => b.includes("community:machine.created"))).toBe(false)
    expect(broadcastBodies.some((b) => b.includes("community:machine.updated"))).toBe(false)
  })

  it("emits machine.updated when runtimes drift between two reconnects", async () => {
    stub.priorLastSeenAt = new Date().toISOString()
    stub.priorAvailableRuntimes = [{ id: "claude" }]
    stub.nextRow = machineRow({ availableRuntimes: [{ id: "claude" }, { id: "codex" }] })
    const { durable, ctx, broadcastBodies } = createDO()
    await deliverReady(durable, {
      runtimeReport: [{ id: "claude" }, { id: "codex" }],
    }, ctx)
    expect(broadcastBodies.some((b) => b.includes("community:machine.updated"))).toBe(true)
  })

  it("does not emit machine.updated when only the order changed", async () => {
    stub.priorLastSeenAt = new Date().toISOString()
    stub.priorAvailableRuntimes = [{ id: "claude" }, { id: "codex" }]
    stub.nextRow = machineRow({ availableRuntimes: [{ id: "codex" }, { id: "claude" }] })
    const { durable, ctx, broadcastBodies } = createDO()
    await deliverReady(durable, {
      runtimeReport: [{ id: "codex" }, { id: "claude" }],
    }, ctx)
    expect(broadcastBodies.some((b) => b.includes("community:machine.updated"))).toBe(false)
  })

  it("does not emit machine.updated when runtimes are unchanged", async () => {
    stub.priorLastSeenAt = new Date().toISOString()
    stub.priorAvailableRuntimes = [{ id: "claude", version: "1.0.0" }]
    stub.nextRow = machineRow({ availableRuntimes: [{ id: "claude", version: "1.0.0" }] })
    const { durable, ctx, broadcastBodies } = createDO()
    await deliverReady(durable, {
      runtimeReport: [{ id: "claude", version: "1.0.0" }],
    }, ctx)
    expect(broadcastBodies.some((b) => b.includes("community:machine.updated"))).toBe(false)
  })
})
