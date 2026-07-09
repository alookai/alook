import { describe, it, expect, vi, beforeEach } from "vitest"

const mockDispatchOneUnreadWake = vi.fn()
const mockCreateDb = vi.fn((..._a: unknown[]) => ({ __db: true }))
vi.mock("@alook/shared", () => {
  const noopLogger = { debug: () => { }, info: () => { }, warn: () => { }, error: () => { }, child() { return this } }
  return {
    createLogger: () => noopLogger,
    createDb: (...a: unknown[]) => mockCreateDb(...a),
    dispatchOneUnreadWake: (...a: unknown[]) => mockDispatchOneUnreadWake(...a),
  }
})

import handler from "./index"

function makeMsg(body: { messageId: string; botUserId: string }) {
  return { body, ack: vi.fn(), retry: vi.fn() }
}

describe("wake-worker queue consumer", () => {
  const env = { WS_DO_WORKER: {}, DB: {} } as unknown as Env

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("resolves via dispatchOneUnreadWake and acks on successful delivery", async () => {
    mockDispatchOneUnreadWake.mockResolvedValue({ outcome: "sent" })
    const msg = makeMsg({ messageId: "msg1", botUserId: "bot1" })
    const batch = { messages: [msg] } as unknown as MessageBatch<unknown>

    await handler.queue(batch as never, env)

    expect(mockCreateDb).toHaveBeenCalledWith(env.DB)
    expect(mockDispatchOneUnreadWake).toHaveBeenCalledWith({ __db: true }, env, { messageId: "msg1", botUserId: "bot1" })
    expect(msg.ack).toHaveBeenCalledTimes(1)
    expect(msg.retry).not.toHaveBeenCalled()
  })

  it("acks (does not retry) when daemon is offline (delivered_nowhere) — known-permanent state", async () => {
    mockDispatchOneUnreadWake.mockResolvedValue({ outcome: "delivered_nowhere", machineId: "m1" })
    const msg = makeMsg({ messageId: "msg1", botUserId: "bot1" })
    const batch = { messages: [msg] } as unknown as MessageBatch<unknown>

    await handler.queue(batch as never, env)

    expect(msg.ack).toHaveBeenCalledTimes(1)
    expect(msg.retry).not.toHaveBeenCalled()
  })

  it("acks when the resolution is a skip", async () => {
    mockDispatchOneUnreadWake.mockResolvedValue({ outcome: "skip", reason: "already_read" })
    const msg = makeMsg({ messageId: "msg1", botUserId: "bot1" })
    const batch = { messages: [msg] } as unknown as MessageBatch<unknown>

    await handler.queue(batch as never, env)

    expect(msg.ack).toHaveBeenCalledTimes(1)
    expect(msg.retry).not.toHaveBeenCalled()
  })

  it.each([
    "message_missing",
    "invalid_message_scope",
    "self_authored",
    "bot_missing",
    "bot_deleted",
    "bot_unbound",
    "bot_not_in_scope",
    "notice_channel_unresolvable",
    "already_read",
  ] as const)("acks for skip reason %s", async (reason) => {
    mockDispatchOneUnreadWake.mockResolvedValue({ outcome: "skip", reason })
    const msg = makeMsg({ messageId: "msg1", botUserId: "bot1" })
    const batch = { messages: [msg] } as unknown as MessageBatch<unknown>

    await handler.queue(batch as never, env)

    expect(msg.ack).toHaveBeenCalledTimes(1)
    expect(msg.retry).not.toHaveBeenCalled()
  })

  it("retries with backoff when dispatchOneUnreadWake throws (D1 exception or transient sendWakeToMachine failure)", async () => {
    mockDispatchOneUnreadWake.mockRejectedValue(new Error("D1 query failed"))
    const msg = makeMsg({ messageId: "msg1", botUserId: "bot1" })
    const batch = { messages: [msg] } as unknown as MessageBatch<unknown>

    await handler.queue(batch as never, env)

    expect(msg.retry).toHaveBeenCalledWith({ delaySeconds: 5 })
    expect(msg.ack).not.toHaveBeenCalled()
  })

  it("processes every message in the batch independently — one failure doesn't block others", async () => {
    mockDispatchOneUnreadWake
      .mockResolvedValueOnce({ outcome: "sent" })
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ outcome: "skip", reason: "already_read" })

    const msgs = [
      makeMsg({ messageId: "msg1", botUserId: "bot1" }),
      makeMsg({ messageId: "msg2", botUserId: "bot2" }),
      makeMsg({ messageId: "msg3", botUserId: "bot3" }),
    ]
    const batch = { messages: msgs } as unknown as MessageBatch<unknown>

    await handler.queue(batch as never, env)

    expect(msgs[0]!.ack).toHaveBeenCalledTimes(1)
    expect(msgs[1]!.retry).toHaveBeenCalledWith({ delaySeconds: 5 })
    expect(msgs[2]!.ack).toHaveBeenCalledTimes(1)
  })
})

describe("wake-worker dev-only HTTP entrypoint (fetch)", () => {
  const env = { WS_DO_WORKER: {}, DB: {} } as unknown as Env

  beforeEach(() => {
    vi.clearAllMocks()
  })

  function makeRequest(method: string, body?: unknown) {
    return new Request("http://internal/", {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  }

  it("resolves every candidate in the body via dispatchOneUnreadWake — the SAME function queue() calls", async () => {
    mockDispatchOneUnreadWake.mockResolvedValue({ outcome: "sent" })
    const payloads = [
      { messageId: "msg1", botUserId: "bot1" },
      { messageId: "msg1", botUserId: "bot2" },
    ]

    const res = await handler.fetch!(makeRequest("POST", payloads), env)

    expect(res.status).toBe(202)
    expect(mockCreateDb).toHaveBeenCalledWith(env.DB)
    expect(mockDispatchOneUnreadWake).toHaveBeenCalledTimes(2)
    expect(mockDispatchOneUnreadWake).toHaveBeenCalledWith({ __db: true }, env, payloads[0])
    expect(mockDispatchOneUnreadWake).toHaveBeenCalledWith({ __db: true }, env, payloads[1])
  })

  it("returns 202 even when a skip/delivered_nowhere outcome resolves (no queue infra to ack/retry against)", async () => {
    mockDispatchOneUnreadWake.mockResolvedValue({ outcome: "skip", reason: "already_read" })

    const res = await handler.fetch!(makeRequest("POST", [{ messageId: "msg1", botUserId: "bot1" }]), env)

    expect(res.status).toBe(202)
  })

  it("still returns 202 when one candidate rejects — siblings are unaffected, failure is only logged", async () => {
    mockDispatchOneUnreadWake
      .mockResolvedValueOnce({ outcome: "sent" })
      .mockRejectedValueOnce(new Error("D1 exploded"))

    const res = await handler.fetch!(
      makeRequest("POST", [
        { messageId: "msg1", botUserId: "bot1" },
        { messageId: "msg2", botUserId: "bot2" },
      ]),
      env,
    )

    expect(res.status).toBe(202)
    expect(mockDispatchOneUnreadWake).toHaveBeenCalledTimes(2)
  })

  it("returns 400 on invalid JSON body", async () => {
    const res = await handler.fetch!(new Request("http://internal/", { method: "POST", body: "not json" }), env)

    expect(res.status).toBe(400)
    expect(mockDispatchOneUnreadWake).not.toHaveBeenCalled()
  })

  it("returns 405 for non-POST methods", async () => {
    const res = await handler.fetch!(makeRequest("GET"), env)

    expect(res.status).toBe(405)
    expect(mockDispatchOneUnreadWake).not.toHaveBeenCalled()
  })
})

/**
 * Equivalence contract: `queue()` (real Cloudflare Queue traffic) and
 * `fetch()` (dev-only stand-in `wake-transport.ts`'s dev HTTP transport
 * calls) MUST resolve a given `WakePayload` identically — same
 * `dispatchOneUnreadWake` call, same args — because they share the exact
 * same `resolveAndLog` helper. This single table is exercised against BOTH
 * entrypoints so a future change that special-cases one of them (instead of
 * `resolveAndLog`) fails a test here, not just in production later.
 *
 * What this table deliberately does NOT assert as equivalent — and never
 * will, see plans/minimal-wake-queue-unread-notice.md — is
 * retry-on-transient-failure: `queue()` retries via Cloudflare's
 * backoff/DLQ; `fetch()` has no queue infra behind it, so a rejection is
 * just logged. That's covered by the entrypoint-specific `describe` blocks
 * above, not here.
 */
const RESOLUTION_SCENARIOS = [
  { name: "sent", outcome: { outcome: "sent" as const } },
  { name: "delivered_nowhere", outcome: { outcome: "delivered_nowhere" as const, machineId: "m1" } },
  { name: "skip: already_read", outcome: { outcome: "skip" as const, reason: "already_read" as const } },
  { name: "skip: bot_not_in_scope", outcome: { outcome: "skip" as const, reason: "bot_not_in_scope" as const } },
]

describe("wake-worker queue() vs fetch() — same resolution for the same candidate", () => {
  const env = { WS_DO_WORKER: {}, DB: {} } as unknown as Env

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it.each(RESOLUTION_SCENARIOS)("calls dispatchOneUnreadWake with identical args for scenario: $name", async ({ outcome }) => {
    const item = { messageId: "msg1", botUserId: "bot1" }

    mockDispatchOneUnreadWake.mockResolvedValue(outcome)
    await handler.queue({ messages: [{ body: item, ack: vi.fn(), retry: vi.fn() }] } as never, env)
    const queueCallArgs = mockDispatchOneUnreadWake.mock.calls[0]

    vi.clearAllMocks()
    mockDispatchOneUnreadWake.mockResolvedValue(outcome)
    await handler.fetch!(new Request("http://internal/", { method: "POST", body: JSON.stringify([item]) }), env)
    const fetchCallArgs = mockDispatchOneUnreadWake.mock.calls[0]

    expect(fetchCallArgs).toEqual(queueCallArgs)
  })

  it("both entrypoints let a sibling's success/skip proceed when one candidate throws", async () => {
    const items = [
      { messageId: "msg1", botUserId: "bot1" },
      { messageId: "msg2", botUserId: "bot2" },
    ]

    mockDispatchOneUnreadWake.mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce({ outcome: "sent" })
    const msgs = items.map((body) => ({ body, ack: vi.fn(), retry: vi.fn() }))
    await handler.queue({ messages: msgs } as never, env)
    expect(msgs[0]!.retry).toHaveBeenCalledTimes(1)
    expect(msgs[1]!.ack).toHaveBeenCalledTimes(1)

    vi.clearAllMocks()
    mockDispatchOneUnreadWake.mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce({ outcome: "sent" })
    const res = await handler.fetch!(new Request("http://internal/", { method: "POST", body: JSON.stringify(items) }), env)
    expect(res.status).toBe(202)
    expect(mockDispatchOneUnreadWake).toHaveBeenCalledTimes(2)
  })
})
