import { describe, it, expect, vi, beforeEach, afterAll } from "vitest"

const mockInfo = vi.fn()
const mockWarn = vi.fn()
const mockError = vi.fn()

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    createLogger: () => ({
      info: (...a: unknown[]) => mockInfo(...a),
      warn: (...a: unknown[]) => mockWarn(...a),
      error: (...a: unknown[]) => mockError(...a),
      debug: vi.fn(),
    }),
  }
})

import { createQueueTransport, createDevHttpQueueTransport } from "./queue-transport"

const payloads = [
  { version: 1 as const, kind: "bot-wake" as const, messageId: "msg_1", botUserId: "bot1" },
  { version: 1 as const, kind: "mobile-push" as const, messageId: "msg_1", userId: "user1" },
]

describe("createQueueTransport", () => {
  it("sends the payloads as a single sendBatch call, one body per candidate", async () => {
    const mockSendBatch = vi.fn(async () => { })
    const transport = createQueueTransport({ sendBatch: mockSendBatch } as unknown as Queue<unknown>)

    await transport.send(payloads)

    expect(mockSendBatch).toHaveBeenCalledTimes(1)
    const [messages] = mockSendBatch.mock.calls[0]!
    expect(messages).toEqual([
      { body: payloads[0], contentType: "json" },
      { body: payloads[1], contentType: "json" },
    ])
  })

  it("propagates a sendBatch rejection (caller decides how to handle per-chunk failure)", async () => {
    const mockSendBatch = vi.fn(async () => { throw new Error("queue unavailable") })
    const transport = createQueueTransport({ sendBatch: mockSendBatch } as unknown as Queue<unknown>)

    await expect(transport.send(payloads)).rejects.toThrow("queue unavailable")
  })
})

describe("createDevHttpQueueTransport", () => {
  const originalFetch = globalThis.fetch
  const mockGlobalFetch = vi.fn<(...args: unknown[]) => Promise<Response>>()

  beforeEach(() => {
    vi.clearAllMocks()
    globalThis.fetch = mockGlobalFetch as unknown as typeof fetch
  })

  afterAll(() => {
    globalThis.fetch = originalFetch
  })

  function makeEnv(bindingFetch?: (...a: unknown[]) => Promise<Response>) {
    return {
      QUEUE_WORKER: bindingFetch ? { fetch: bindingFetch } : undefined,
      DEV_QUEUE_WORKER_URL: "http://dev-queue:8790",
    } as unknown as Env
  }

  it("POSTs the full task batch as JSON to the alook-queue-worker binding", async () => {
    const bindingFetch = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://internal/")
      expect(init?.method).toBe("POST")
      expect(JSON.parse(init!.body as string)).toEqual(payloads)
      return new Response(null, { status: 202 })
    })
    const transport = createDevHttpQueueTransport(makeEnv(bindingFetch))

    await expect(transport.send(payloads)).resolves.toBeUndefined()
    expect(bindingFetch).toHaveBeenCalledTimes(1)
    expect(mockGlobalFetch).not.toHaveBeenCalled()
  })

  it("falls back to the raw dev HTTP URL when the binding is absent", async () => {
    mockGlobalFetch.mockResolvedValue(new Response(null, { status: 202 }))
    const transport = createDevHttpQueueTransport(makeEnv())

    await transport.send(payloads)

    expect(mockGlobalFetch).toHaveBeenCalledTimes(1)
    expect(String(mockGlobalFetch.mock.calls[0]![0])).toBe("http://dev-queue:8790/")
  })

  it("falls back to HTTP when the binding throws (getPlatformProxy binding unreachable)", async () => {
    const bindingFetch = vi.fn(async () => { throw new Error("binding missing") })
    mockGlobalFetch.mockResolvedValue(new Response(null, { status: 202 }))
    const transport = createDevHttpQueueTransport(makeEnv(bindingFetch))

    await transport.send(payloads)

    expect(bindingFetch).toHaveBeenCalledTimes(1)
    expect(mockGlobalFetch).toHaveBeenCalledTimes(1)
  })

  it("does not replay a processed batch through HTTP fallback when the binding reports partial candidate exhaustion", async () => {
    const bindingFetch = vi.fn(async () => Response.json(
      { failed: [payloads[0]] },
      { status: 207 },
    ))
    mockGlobalFetch.mockResolvedValue(new Response(null, { status: 202 }))
    const transport = createDevHttpQueueTransport(makeEnv(bindingFetch))

    await expect(transport.send(payloads)).rejects.toThrow(/partial.*1 task/i)

    expect(bindingFetch).toHaveBeenCalledTimes(1)
    expect(mockGlobalFetch).not.toHaveBeenCalled()
  })

  it("accepts an exact mobile-push candidate in a partial response", async () => {
    const bindingFetch = vi.fn(async () => Response.json(
      { failed: [payloads[1]] },
      { status: 207 },
    ))
    mockGlobalFetch.mockResolvedValue(new Response(null, { status: 202 }))
    const transport = createDevHttpQueueTransport(makeEnv(bindingFetch))

    await expect(transport.send(payloads)).rejects.toThrow(/partial.*1 task/i)

    expect(bindingFetch).toHaveBeenCalledTimes(1)
    expect(mockGlobalFetch).not.toHaveBeenCalled()
  })

  it.each([
    { name: "non-JSON body", body: "not json" },
    { name: "invalid common fields", body: JSON.stringify({ failed: [{ version: 2, kind: "bot-wake", messageId: "msg_1", botUserId: "bot1" }] }) },
    { name: "missing botUserId", body: JSON.stringify({ failed: [{ version: 1, kind: "bot-wake", messageId: "msg_1" }] }) },
    { name: "unknown kind", body: JSON.stringify({ failed: [{ version: 1, kind: "email", messageId: "msg_1", userId: "user1" }] }) },
    { name: "unexpected top-level field", body: JSON.stringify({ failed: [], extra: true }) },
    { name: "empty failed list", body: JSON.stringify({ failed: [] }) },
    { name: "candidate outside the sent batch", body: JSON.stringify({ failed: [{ ...payloads[0], messageId: "other" }] }) },
    { name: "duplicate failed tuple", body: JSON.stringify({ failed: [payloads[0], payloads[0]] }) },
  ])("fails closed without fallback for an invalid 207 response: $name", async ({ body }) => {
    const bindingFetch = vi.fn(async () => new Response(body, { status: 207 }))
    mockGlobalFetch.mockResolvedValue(new Response(null, { status: 202 }))
    const transport = createDevHttpQueueTransport(makeEnv(bindingFetch))

    await expect(transport.send(payloads)).rejects.toThrow(/invalid partial response/i)

    expect(bindingFetch).toHaveBeenCalledTimes(1)
    expect(mockGlobalFetch).not.toHaveBeenCalled()
  })

  it("still falls back to HTTP when the binding returns a worker-level 5xx", async () => {
    const bindingFetch = vi.fn(async () => new Response("worker unavailable", { status: 503 }))
    mockGlobalFetch.mockResolvedValue(new Response(null, { status: 202 }))
    const transport = createDevHttpQueueTransport(makeEnv(bindingFetch))

    await expect(transport.send(payloads)).resolves.toBeUndefined()

    expect(bindingFetch).toHaveBeenCalledTimes(1)
    expect(mockGlobalFetch).toHaveBeenCalledTimes(1)
  })

  it("throws when both the binding and the HTTP fallback respond non-OK (caller logs, dev-only best effort)", async () => {
    const bindingFetch = vi.fn(async () => new Response("boom", { status: 500 }))
    mockGlobalFetch.mockResolvedValue(new Response("still bad", { status: 500 }))
    const transport = createDevHttpQueueTransport(makeEnv(bindingFetch))

    await expect(transport.send(payloads)).rejects.toThrow(/500/)
  })
})
