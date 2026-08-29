import { vi } from "vitest"
import { createMockCtx, createMockWebSocket } from "../__mocks__/cf"

const loggerMocks = vi.hoisted(() => ({
  mockLogDebug: vi.fn(),
  mockLogInfo: vi.fn(),
  mockLogWarn: vi.fn(),
  mockLogError: vi.fn(),
}))
const deliveryTransportMocks = vi.hoisted(() => ({
  encodePreparedCommunityBrowserEventBatch: vi.fn(),
}))
export const mockEncodePreparedCommunityBrowserEventBatch =
  deliveryTransportMocks.encodePreparedCommunityBrowserEventBatch
export const mockLogDebug = loggerMocks.mockLogDebug
const mockLogInfo = loggerMocks.mockLogInfo
export const mockLogWarn = loggerMocks.mockLogWarn
const mockLogError = loggerMocks.mockLogError

// --- Cloudflare Workers globals that don't exist in Node ---

// Replace the global Response with one that allows status 101 and a webSocket property
export class CFResponse {
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
  constructor(public request: string, public response: string) { }
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
export const mockGetValidSession = vi.fn<(db: unknown, token: string) => Promise<string | null>>()
export const mockGetValidSessionWithIdentity = vi.fn<(db: unknown, token: string) => Promise<{ userId: string; name: string; discriminator: string } | null>>()
export const mockGetMachineTokenByToken = vi.fn()
export const mockGetLatestTokenForUser = vi.fn()
export const mockGetRuntimeIdsByDaemon = vi.fn()
export const mockGetMachineByDaemon = vi.fn().mockResolvedValue({ daemonId: "my-daemon", workspaceId: "sp_ws1" })
export const mockCreateDb = vi.fn().mockReturnValue({})
export const mockHashCredential = vi.fn(async (bearer: string) => `hash:${bearer}`)
export const mockFindCredentialByHash = vi.fn()
export const mockGetMachineByIdForUser = vi.fn()
export const mockUpsertMachineByMachineId = vi.fn()
export const mockTouchMachineHeartbeat = vi.fn()
export const mockMarkMachineOffline = vi.fn()
export const mockMarkMachineOnlineIfOffline = vi.fn()
export const mockTimeoutPendingDiagnosticReportsForMachine = vi.fn().mockResolvedValue([])
export const mockGetNextPendingDiagnosticDeadlineForMachine = vi.fn().mockResolvedValue(null)
export const mockGetCoMemberUserIds = vi.fn<(db: unknown, userId: string) => Promise<string[]>>().mockResolvedValue([])
export const mockGetFriendUserIds = vi.fn<(db: unknown, userId: string) => Promise<string[]>>().mockResolvedValue([])
export const mockGetChannelForMember = vi.fn()
export const mockListChannelMemberUserIds = vi.fn<(db: unknown, channelId: string) => Promise<string[]>>().mockResolvedValue([])
export const mockIsChannelPrivate = vi.fn<(db: unknown, channelId: string) => Promise<boolean>>().mockResolvedValue(false)
export const mockGetPrivateChannelAudienceUserIds = vi.fn<(db: unknown, channelId: string) => Promise<string[]>>().mockResolvedValue([])
export const mockResolveScopeMemberUserIds = vi.fn<(db: unknown, opts: { scope: string; scopeId: string }) => Promise<string[]>>().mockResolvedValue([])
// Default: non-thread channel → typing uses the shared resolver path.
export const mockGetChannelType = vi.fn<(db: unknown, channelId: string) => Promise<string | null>>().mockResolvedValue("text")
export const mockListThreadParticipantUserIds = vi.fn<(db: unknown, channelId: string) => Promise<string[]>>().mockResolvedValue([])
async function resolveChannelRecipientUserIdsMock(db: unknown, channelId: string): Promise<string[]> {
  const type = await mockGetChannelType(db, channelId)
  if (type === "thread") return mockListThreadParticipantUserIds(db, channelId)
  if (type === "dm") return mockListChannelMemberUserIds(db, channelId)
  return mockResolveScopeMemberUserIds(db, { scope: "channel", scopeId: channelId })
}
export const mockResolveChannelRecipientUserIds = vi.fn(resolveChannelRecipientUserIdsMock)
export const mockWithD1Retry = vi.fn(async <T>(fn: () => Promise<T>, _opts?: unknown): Promise<T> => fn())
export const mockGetDM = vi.fn()
export const mockListMembers = vi.fn()
export const mockListBotsForMachine = vi.fn<(db: unknown, machineId: string) => Promise<Array<{ id: string; name: string; discriminator: string; description: string }>>>().mockResolvedValue([])
export const mockIsBotOnline = vi.fn<(db: unknown, botUserId: string) => Promise<boolean>>().mockResolvedValue(false)
export const mockGetBotBinding = vi.fn<(db: unknown, botId: string) => Promise<{ machineId: string; runtime: string } | null>>().mockResolvedValue(null)
export const mockGetBotBindingWithOwner = vi.fn<(db: unknown, botId: string) => Promise<{ machineId: string; runtime: string; ownerUserId: string; name: string; discriminator: string } | null>>().mockResolvedValue(null)
export const mockInsertBotActivityEventAndPrune = vi.fn<(db: unknown, data: any, extraStatements?: unknown[]) => Promise<{ id: string; createdAt: string } | null>>().mockResolvedValue(null)
export const mockInsertBotAuditSessionReset = vi.fn<(db: unknown, data: unknown) => Promise<{ id: string; createdAt: string } | null>>().mockResolvedValue(null)
export const mockInsertBotAuditNap = vi.fn<(db: unknown, data: unknown) => Promise<{ id: string; createdAt: string } | null>>().mockResolvedValue(null)
export const mockInsertBotAuditModelChanged = vi.fn<(db: unknown, data: unknown) => Promise<{ id: string; createdAt: string } | null>>().mockResolvedValue(null)
export const mockInsertBotAuditProviderChanged = vi.fn<(db: unknown, data: unknown) => Promise<{ id: string; createdAt: string } | null>>().mockResolvedValue(null)
export const mockTouchBotRefreshContext = vi.fn<(db: unknown, botId: string, now: string) => Promise<void>>().mockResolvedValue(undefined)
export const mockTouchBotRefreshContextForAuditEventStatement = vi.fn().mockReturnValue({ __stmt: "touch-awake" })
export const mockUpdateProfile = vi
  .fn<(db: unknown, userId: string, data: { statusEmoji?: string | null; statusText?: string | null }) => Promise<unknown>>()
  .mockResolvedValue({})
export const mockGetProfile = vi
  .fn<(db: unknown, userId: string) => Promise<{ statusEmoji: string | null; statusText: string | null } | null>>()
  .mockResolvedValue(null)
export const mockReconcileBotActivityFromRunningAgents = vi
  .fn<(db: unknown, machineId: string, runningAgentIds: string[]) => Promise<Array<{ botUserId: string; statusEmoji: string; statusText: string }>>>()
  .mockResolvedValue([])
const mockD1Prepare = vi.fn((sql: string) => ({
  bind: (...values: unknown[]) => ({ sql, values }),
}))
export const mockD1Batch = vi.fn(async (statements: unknown[]) =>
  statements.map(() => ({ success: true, meta: { changes: 1 } })))
export const mockGetUserInternal = vi.fn<(db: unknown, id: string) => Promise<{ isBot: boolean; ownerUserId: string | null } | null>>().mockResolvedValue(null)
// mockToSummary now returns row.status verbatim — status is the source of
// truth on the column, not a derivation from lastSeenAt. See
// plans/community-machine-presence-fix.md.
export const mockToSummary = vi.fn((row: any) => ({
  id: row.id,
  hostname: row.hostname ?? "",
  displayName: row.displayName ?? row.hostname ?? "",
  platform: row.platform ?? "",
  arch: row.arch ?? "",
  osRelease: row.osRelease ?? "",
  daemonVersion: row.daemonVersion ?? "",
  lastSeenAt: row.lastSeenAt ?? null,
  status: (row.status as "online" | "offline") ?? "offline",
  availableRuntimes: row.availableRuntimes ?? [],
  createdAt: row.createdAt ?? "",
  updatedAt: row.updatedAt ?? "",
}))

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  mockEncodePreparedCommunityBrowserEventBatch.mockImplementation(
    (input: Parameters<typeof actual.encodePreparedCommunityBrowserEventBatch>[0]) =>
      actual.encodePreparedCommunityBrowserEventBatch(input),
  )
  const noopLogger = {
    debug: mockLogDebug,
    info: mockLogInfo,
    warn: mockLogWarn,
    error: mockLogError,
    child: () => noopLogger,
  }
  // Bare-minimum safeParse stubs — the DO only calls `.safeParse(msg)` and
  // reads `.success` / `.data`. Enough to route the test frames correctly
  // without pulling in zod (which isn't a direct dep of @alook/ws-do).
  const SessionErrorFrameSchema = {
    safeParse(v: unknown) {
      const m = v as { type?: unknown; code?: unknown; agentId?: unknown; launchId?: unknown; payload?: unknown }
      if (m?.type !== "session.error" || m?.code !== "runtime_not_available") {
        return { success: false } as const
      }
      return {
        success: true as const,
        data: {
          type: "session.error" as const,
          code: "runtime_not_available" as const,
          agentId: typeof m.agentId === "string" ? (m.agentId as string) : undefined,
          // launchId rides the frame now (Melisa's source half) — the DO uses
          // it to evict pending reset/nap attribution on cold-start branch A.
          launchId: typeof m.launchId === "string" ? (m.launchId as string) : undefined,
          payload: (m.payload as Record<string, unknown> | undefined) ?? undefined,
        },
      }
    },
  }
  const HostReadyMessageSchema = actual.HostReadyMessageSchema
  const MachineHeartbeatAckMessageSchema = {
    safeParse(v: unknown) {
      const m = v as { type?: unknown; nonce?: unknown }
      return m?.type === "machine_heartbeat_ack" && typeof m.nonce === "string" && m.nonce.length > 0
        ? { success: true as const, data: { type: "machine_heartbeat_ack" as const, nonce: m.nonce } }
        : { success: false as const }
    },
  }
  const DiagnosticCommandAckMessageSchema = {
    safeParse(v: unknown) {
      const m = v as { type?: unknown; reportId?: unknown }
      return m?.type === "diagnostics_ack" && typeof m.reportId === "string" && /^dbr_[A-Za-z0-9_-]+$/.test(m.reportId)
        ? { success: true as const, data: { type: "diagnostics_ack" as const, reportId: m.reportId } }
        : { success: false as const }
    },
  }
  const AgentActivityMessageSchema = actual.AgentActivityMessageSchema
  const AgentTypingMessageSchema = {
    safeParse(v: unknown) {
      const m = v as { type?: unknown; agentId?: unknown; channelId?: unknown }
      if (m?.type !== "agent_typing") return { success: false } as const
      if (typeof m.agentId !== "string" || m.agentId.length === 0) return { success: false } as const
      if (typeof m.channelId !== "string" || m.channelId.length === 0) return { success: false } as const
      return {
        success: true as const,
        data: { type: "agent_typing" as const, agentId: m.agentId, channelId: m.channelId },
      }
    },
  }
  const AgentTypingStopMessageSchema = {
    safeParse(v: unknown) {
      const m = v as { type?: unknown; agentId?: unknown; channelId?: unknown }
      if (m?.type !== "agent_typing_stop") return { success: false } as const
      if (typeof m.agentId !== "string" || m.agentId.length === 0) return { success: false } as const
      if (typeof m.channelId !== "string" || m.channelId.length === 0) return { success: false } as const
      return {
        success: true as const,
        data: { type: "agent_typing_stop" as const, agentId: m.agentId, channelId: m.channelId },
      }
    },
  }
  const AgentSessionMessageSchema = {
    safeParse(v: unknown) {
      const m = v as { type?: unknown; agentId?: unknown; sessionId?: unknown; launchId?: unknown }
      if (m?.type !== "agent_session") return { success: false } as const
      if (typeof m.agentId !== "string" || m.agentId.length === 0) return { success: false } as const
      if (typeof m.sessionId !== "string" || m.sessionId.length === 0) return { success: false } as const
      if (typeof m.launchId !== "string" || m.launchId.length === 0) return { success: false } as const
      return {
        success: true as const,
        data: {
          type: "agent_session" as const,
          agentId: m.agentId,
          sessionId: m.sessionId,
          launchId: m.launchId,
        },
      }
    },
  }
  const HostBotAuditEventFrameSchema = {
    safeParse(v: unknown) {
      const m = v as { type?: unknown; eventId?: unknown; occurredAt?: unknown; agentId?: unknown; sessionId?: unknown; launchId?: unknown; event?: unknown }
      if (m?.type !== "bot_audit_event") return { success: false } as const
      if (typeof m.agentId !== "string" || m.agentId.length === 0) return { success: false } as const
      const ev = m.event as { kind?: unknown; payload?: unknown }
      if (!ev || typeof ev !== "object") return { success: false } as const
      const kind = ev.kind
      const payload = ev.payload as Record<string, unknown> | undefined
      if (!payload || typeof payload !== "object") return { success: false } as const
      let ok = false
      if (kind === "cli_invocation") ok = typeof payload.subcommand === "string"
      else if (kind === "tool_call") ok = typeof payload.name === "string"
      else if (kind === "thinking")
        ok = typeof payload.text === "string" && typeof payload.truncated === "boolean" && typeof payload.chars === "number"
      else if (kind === "session_reset")
        ok = payload.trigger === "single" || payload.trigger === "reset_all" || payload.trigger === "idle_timeout"
      if (kind === "session_reset" && payload.trigger === "idle_timeout") {
        ok = ok
          && typeof m.eventId === "string"
          && m.eventId.length > 0
          && typeof m.occurredAt === "string"
          && Number.isFinite(Date.parse(m.occurredAt))
      }
      if (!ok) return { success: false } as const
      return {
        success: true as const,
        data: {
          type: "bot_audit_event" as const,
          eventId: typeof m.eventId === "string" ? m.eventId : undefined,
          occurredAt: typeof m.occurredAt === "string" ? m.occurredAt : undefined,
          agentId: m.agentId,
          sessionId: typeof m.sessionId === "string" ? m.sessionId : m.sessionId === null ? null : undefined,
          launchId: typeof m.launchId === "string" ? m.launchId : m.launchId === null ? null : undefined,
          event: { kind, payload },
        },
      }
    },
  }
  return {
    ...actual,
    encodePreparedCommunityBrowserEventBatch: (
      input: Parameters<typeof actual.encodePreparedCommunityBrowserEventBatch>[0],
    ) => mockEncodePreparedCommunityBrowserEventBatch(input),
    // Real WS event-type strings the DO reads at runtime (#5 T2 — ws-do
    // broadcasts now use WS_EVENTS.* instead of raw literals). Values match
    // @alook/shared so the event assertions still hold.
    WS_EVENTS: {
      TYPING_START: "community:typing.start",
      TYPING_STOP: "community:typing.stop",
      MACHINE_STATUS: "community:machine.status",
      MACHINE_UPDATED: "community:machine.updated",
      STATUS_UPDATE: "community:status.update",
      BOT_AUDIT_EVENT: "community:bot.audit_event",
      PRESENCE_UPDATE: "community:presence.update",
    },
    createDb: (d1: unknown) => mockCreateDb(d1),
    createLogger: () => noopLogger,
    withD1Retry: <T>(fn: () => Promise<T>, opts?: unknown): Promise<T> =>
      mockWithD1Retry(fn, opts) as Promise<T>,
    // Minimal `readOrStale` shim — bypasses the classifier so tests can
    // inject arbitrary Error shapes at the query-fn boundary and observe
    // fail-closed semantics. Real production behavior (retry then fallback)
    // is covered by the shared `resilience.test.ts` suite.
    readOrStale: async <T>(
      fn: () => Promise<T>,
      fallback: T,
      _opts?: unknown,
    ): Promise<{ value: T; stale: boolean }> => {
      try { return { value: await fn(), stale: false } }
      catch { return { value: fallback, stale: true } }
    },
    COMMUNITY_MACHINE_HEARTBEAT_MS: 60_000,
    COMMUNITY_MACHINE_OFFLINE_THRESHOLD_MS: 120_000,
    SessionErrorFrameSchema,
    HostReadyMessageSchema,
    AgentActivityMessageSchema,
    AgentTypingMessageSchema,
    AgentTypingStopMessageSchema,
    AgentSessionMessageSchema,
    HostBotAuditEventFrameSchema,
    // Deterministic preset picker so the assertion can pin exact
    // `statusEmoji`/`statusText` values regardless of the injected `seed`.
    pickBotActivityPreset: (state: string) => {
      if (state === "running") return { emoji: "⚡", text: "Working on it" }
      if (state === "starting") return { emoji: "🌀", text: "Waking up" }
      if (state === "stopping") return { emoji: "🌙", text: "Wrapping up" }
      return { emoji: "💤", text: "Idle" }
    },
    RUNNING_PRESETS: [
      { emoji: "⚡", text: "Working on it" },
      { emoji: "🛠️", text: "Cooking" },
      { emoji: "🧠", text: "Thinking hard" },
      { emoji: "🔧", text: "Tinkering" },
      { emoji: "🚀", text: "On it" },
      { emoji: "🔥", text: "In the zone" },
    ],
    // Real impl of the write-path/reconciler guard — mirrors the shared module
    // over the presets emitted above (idle/starting/stopping + running pool).
    isBotActivityStatus: (emoji: string | null, text: string | null) => {
      if (emoji === null && text === null) return false
      const pairs = [
        { emoji: "💤", text: "Idle" },
        { emoji: "🌀", text: "Waking up" },
        { emoji: "🌙", text: "Wrapping up" },
        { emoji: "⚡", text: "Working on it" },
        { emoji: "🛠️", text: "Cooking" },
        { emoji: "🧠", text: "Thinking hard" },
        { emoji: "🔧", text: "Tinkering" },
        { emoji: "🚀", text: "On it" },
        { emoji: "🔥", text: "In the zone" },
      ]
      return pairs.some((p) => p.emoji === emoji && p.text === text)
    },
    queries: {
      session: {
        getValidSession: (db: unknown, token: string) => mockGetValidSession(db, token),
        getValidSessionWithIdentity: (db: unknown, token: string) => mockGetValidSessionWithIdentity(db, token),
      },
      machineToken: {
        getMachineTokenByToken: (...a: any[]) => mockGetMachineTokenByToken(...a),
        getLatestTokenForUser: (...a: any[]) => mockGetLatestTokenForUser(...a),
      },
      runtime: { getRuntimeIdsByDaemon: (...a: any[]) => mockGetRuntimeIdsByDaemon(...a) },
      machine: { getMachineByDaemon: (...a: any[]) => mockGetMachineByDaemon(...a) },
      communityMachine: {
        hashCredential: (bearer: string) => mockHashCredential(bearer),
        findCredentialByHash: (...a: any[]) => mockFindCredentialByHash(...a),
        getMachineByIdForUser: (...a: any[]) => mockGetMachineByIdForUser(...a),
        toSummary: (row: any) => mockToSummary(row),
        isBotOnline: (...a: [unknown, string]) => mockIsBotOnline(...a),
        reconcileBotActivityFromRunningAgents: (...a: any[]) =>
          mockReconcileBotActivityFromRunningAgents(...(a as [unknown, string, string[]])),
      },
      communityMachineSession: {
        transitionMachineSessionEpoch: async (db: unknown, command: any) => {
          if (command.type === "ready") {
            const result = await mockUpsertMachineByMachineId(
              db,
              command.epoch.userId,
              command.epoch.machineId,
              command.metadata,
              command.epoch.credentialHash,
            )
            return result ? { type: "transitioned", ...result } : { type: "stale_epoch" }
          }
          if (command.type === "renew") {
            const result = await mockTouchMachineHeartbeat(
              db,
              command.epoch.userId,
              command.epoch.machineId,
              command.epoch.credentialHash,
            )
            return result ? { type: "transitioned", ...result } : { type: "stale_epoch" }
          }
          const machine = await mockMarkMachineOffline(db, command.epoch)
          return machine
            ? {
                type: "transitioned",
                machine,
                priorLastSeenAt: machine.lastSeenAt ?? null,
                priorAvailableRuntimes: machine.availableRuntimes ?? [],
                priorDaemonVersion: machine.daemonVersion ?? "",
                priorStatus: "online",
              }
            : { type: "stale_epoch" }
        },
      },
      communityDiagnosticReport: {
        timeoutPendingDiagnosticReportsForMachine: (...a: any[]) => mockTimeoutPendingDiagnosticReportsForMachine(...a),
        getNextPendingDiagnosticDeadlineForMachine: (...a: any[]) => mockGetNextPendingDiagnosticDeadlineForMachine(...a),
      },
      communityUserProfile: {
        updateProfile: (...a: any[]) =>
          mockUpdateProfile(...(a as [unknown, string, { statusEmoji?: string | null; statusText?: string | null }])),
        getProfile: (...a: any[]) => mockGetProfile(...(a as [unknown, string])),
      },
      communityMember: {
        getCoMemberUserIds: (...a: [unknown, string]) => mockGetCoMemberUserIds(...a),
        listMembers: (...a: any[]) => mockListMembers(...a),
      },
      communityFriendship: {
        getFriendUserIds: (...a: [unknown, string]) => mockGetFriendUserIds(...a),
      },
      communityChannel: {
        getChannelForMember: (...a: any[]) => mockGetChannelForMember(...a),
        getChannelType: (...a: any[]) => mockGetChannelType(...a),
        listChannelMemberUserIds: (...a: any[]) => mockListChannelMemberUserIds(...a),
        isChannelPrivate: (...a: any[]) => mockIsChannelPrivate(...a),
        getPrivateChannelAudienceUserIds: (...a: any[]) => mockGetPrivateChannelAudienceUserIds(...a),
      },
      communityMembersResolver: {
        resolveScopeMemberUserIds: (...a: any[]) => mockResolveScopeMemberUserIds(...a),
        resolveChannelRecipientUserIds: (...a: [unknown, string]) =>
          mockResolveChannelRecipientUserIds(...a),
      },
      communityThread: {
        listThreadParticipantUserIds: (...a: any[]) => mockListThreadParticipantUserIds(...a),
      },
      communityDm: {
        getDM: (...a: any[]) => mockGetDM(...a),
      },
      communityBot: {
        listBotsForMachine: (...a: [unknown, string]) => mockListBotsForMachine(...a),
        getBotBinding: (...a: [unknown, string]) => mockGetBotBinding(...a),
        getBotBindingWithOwner: (...a: [unknown, string]) => mockGetBotBindingWithOwner(...a),
        touchBotRefreshContext: (...a: [unknown, string, string]) => mockTouchBotRefreshContext(...a),
        touchBotRefreshContextForAuditEventStatement: (...a: [unknown, string, string, string]) =>
          mockTouchBotRefreshContextForAuditEventStatement(...a),
      },
      communityBotAuditLog: {
        insertBotActivityEventAndPrune: (...a: any[]) => mockInsertBotActivityEventAndPrune(...a),
        insertBotAuditSessionReset: (...a: any[]) => mockInsertBotAuditSessionReset(...a),
        insertBotAuditNap: (...a: any[]) => mockInsertBotAuditNap(...a),
        insertBotAuditModelChanged: (...a: any[]) => mockInsertBotAuditModelChanged(...a),
        insertBotAuditProviderChanged: (...a: any[]) => mockInsertBotAuditProviderChanged(...a),
      },
      user: {
        getUserInternal: (...a: [unknown, string]) => mockGetUserInternal(...a),
      },
    },
    CONTROL_HEARTBEAT_CAPABILITY: "control-heartbeat-v1",
    MachineHeartbeatAckMessageSchema,
    DiagnosticCommandAckMessageSchema,
  }
})

// Import after mocks
const { WebSocketDurableObject } = await import("../ws-durable")

export const mockStubFetch = vi.fn().mockResolvedValue(new (globalThis.Response as any)(JSON.stringify({ sent: 1 })))
export const mockCheckAliveFetch = vi.fn().mockResolvedValue(new (globalThis.Response as any)(JSON.stringify({ alive: true })))

export function createDO() {
  const { ctx, getWebSockets, storage, store } = createMockCtx()
  const stubGet = vi.fn().mockReturnValue({ fetch: mockStubFetch })
  const env = {
    DB: {
      prepare: (sql: string) => mockD1Prepare(sql),
      batch: (statements: unknown[]) => mockD1Batch(statements),
    } as unknown as D1Database,
    WS_DO: {
      idFromName: vi.fn().mockReturnValue("mock-do-id"),
      get: stubGet,
    } as unknown as DurableObjectNamespace,
    RATE_LIMIT_DO: {} as DurableObjectNamespace,
  }
  const durable = new WebSocketDurableObject(ctx, env)
  return { durable, ctx, getWebSockets, env, stubGet, storage, store }
}

export const flushAsyncWork = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}
export function resetHarness() {
    vi.clearAllMocks()
    // `clearAllMocks` doesn't undo a `mockResolvedValue` set by a prior test —
    // re-pin these two to their empty default so presence-audience tests
    // don't leak state into unrelated auth-flow tests.
    mockGetCoMemberUserIds.mockResolvedValue([])
    mockGetFriendUserIds.mockResolvedValue([])
    mockListBotsForMachine.mockResolvedValue([])
    mockIsBotOnline.mockResolvedValue(false)
    mockGetUserInternal.mockResolvedValue(null)
    mockIsChannelPrivate.mockResolvedValue(false)
    mockGetPrivateChannelAudienceUserIds.mockResolvedValue([])
    // Non-thread default so typing uses the shared resolver path; the
    // thread-typing test overrides this.
    mockGetChannelType.mockResolvedValue("text")
    mockListThreadParticipantUserIds.mockResolvedValue([])
    mockListChannelMemberUserIds.mockResolvedValue([])
    mockResolveScopeMemberUserIds.mockResolvedValue([])
    mockResolveChannelRecipientUserIds.mockImplementation(resolveChannelRecipientUserIdsMock)
    mockWithD1Retry.mockImplementation(async <T>(fn: () => Promise<T>, _opts?: unknown): Promise<T> => fn())
    mockGetBotBinding.mockResolvedValue(null)
    mockUpdateProfile.mockResolvedValue({})
    mockGetProfile.mockResolvedValue(null)
    mockReconcileBotActivityFromRunningAgents.mockResolvedValue([])
    mockD1Prepare.mockImplementation((sql: string) => ({
      bind: (...values: unknown[]) => ({ sql, values }),
    }))
    mockD1Batch.mockImplementation(async (statements: unknown[]) =>
      statements.map(() => ({ success: true, meta: { changes: 1 } })))
    mockTimeoutPendingDiagnosticReportsForMachine.mockResolvedValue([])
    mockGetNextPendingDiagnosticDeadlineForMachine.mockResolvedValue(null)
    // Daemon-auth binds the token to a machine row for daemonId+workspace;
    // default to a present row so auth-flow success tests pass. Tests that
    // exercise a missing machine override this.
    mockGetMachineByDaemon.mockResolvedValue({ daemonId: "my-daemon", workspaceId: "sp_ws1" })

}

export function cleanupHarness() {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.clearAllMocks()
}
