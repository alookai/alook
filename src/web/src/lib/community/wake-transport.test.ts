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

import { createQueueWakeTransport, createDevHttpWakeTransport } from "./wake-transport"

const payloads = [
  { messageId: "msg_1", botUserId: "bot1" },
  { messageId: "msg_1", botUserId: "bot2" },
]

describe("createQueueWakeTransport", () => {
  it("sends the payloads as a single sendBatch call, one body per candidate", async () => {
    const mockSendBatch = vi.fn(async () => { })
    const transport = createQueueWakeTransport({ sendBatch: mockSendBatch } as unknown as Queue<unknown>)

    await transport.send(payloads)

    expect(mockSendBatch).toHaveBeenCalledTimes(1)
    const [messages] = mockSendBatch.mock.calls[0]!
    expect(messages).toEqual([{ body: payloads[0] }, { body: payloads[1] }])
  })

  it("propagates a sendBatch rejection (caller decides how to handle per-chunk failure)", async () => {
    const mockSendBatch = vi.fn(async () => { throw new Error("queue unavailable") })
    const transport = createQueueWakeTransport({ sendBatch: mockSendBatch } as unknown as Queue<unknown>)

    await expect(transport.send(payloads)).rejects.toThrow("queue unavailable")
  })
})

describe("createDevHttpWakeTransport", () => {
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
      WAKE_WORKER: bindingFetch ? { fetch: bindingFetch } : undefined,
      DEV_WAKE_WORKER_URL: "http://dev-wake:8790",
    } as unknown as Env
  }

  it("POSTs the full payload batch as JSON to the alook-wake-worker binding", async () => {
    const bindingFetch = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://internal/")
      expect(init?.method).toBe("POST")
      expect(JSON.parse(init!.body as string)).toEqual(payloads)
      return new Response(null, { status: 202 })
    })
    const transport = createDevHttpWakeTransport(makeEnv(bindingFetch))

    await expect(transport.send(payloads)).resolves.toBeUndefined()
    expect(bindingFetch).toHaveBeenCalledTimes(1)
    expect(mockGlobalFetch).not.toHaveBeenCalled()
  })

  it("falls back to the raw dev HTTP URL when the binding is absent", async () => {
    mockGlobalFetch.mockResolvedValue(new Response(null, { status: 202 }))
    const transport = createDevHttpWakeTransport(makeEnv())

    await transport.send(payloads)

    expect(mockGlobalFetch).toHaveBeenCalledTimes(1)
    expect(String(mockGlobalFetch.mock.calls[0]![0])).toBe("http://dev-wake:8790/")
  })

  it("falls back to HTTP when the binding throws (getPlatformProxy binding unreachable)", async () => {
    const bindingFetch = vi.fn(async () => { throw new Error("binding missing") })
    mockGlobalFetch.mockResolvedValue(new Response(null, { status: 202 }))
    const transport = createDevHttpWakeTransport(makeEnv(bindingFetch))

    await transport.send(payloads)

    expect(bindingFetch).toHaveBeenCalledTimes(1)
    expect(mockGlobalFetch).toHaveBeenCalledTimes(1)
  })

  it("throws when both the binding and the HTTP fallback respond non-OK (caller logs, dev-only best effort)", async () => {
    const bindingFetch = vi.fn(async () => new Response("boom", { status: 500 }))
    mockGlobalFetch.mockResolvedValue(new Response("still bad", { status: 500 }))
    const transport = createDevHttpWakeTransport(makeEnv(bindingFetch))

    await expect(transport.send(payloads)).rejects.toThrow(/500/)
  })
})
