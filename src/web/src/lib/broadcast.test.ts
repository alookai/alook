import { describe, it, expect, vi, beforeEach, afterAll } from "vitest"

const mockInfo = vi.fn()
const mockWarn = vi.fn()
const mockError = vi.fn()
const mockDebug = vi.fn()
const mockCtxWaitUntil = vi.fn()
const mockGetCloudflareContext = vi.fn()

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: (...a: unknown[]) => mockGetCloudflareContext(...(a as [])),
}))

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    createLogger: () => ({
      info: (...a: unknown[]) => mockInfo(...a),
      warn: (...a: unknown[]) => mockWarn(...a),
      error: (...a: unknown[]) => mockError(...a),
      debug: (...a: unknown[]) => mockDebug(...a),
    }),
  }
})

import { wsDoFetch, broadcastToUser, broadcastToUsers } from "./broadcast"

const communityEvent = {
  type: "community:presence.update",
  userId: "event-user",
  online: true,
} as const

const originalFetch = globalThis.fetch
const mockFetch = vi.fn<(...args: unknown[]) => Promise<Response>>()

beforeEach(() => {
  vi.clearAllMocks()
  globalThis.fetch = mockFetch as unknown as typeof fetch
})

afterAll(() => {
  globalThis.fetch = originalFetch
})

function makeEnv(bindingFetch: (...args: unknown[]) => Promise<Response>): Env {
  return {
    WS_DO_WORKER: { fetch: bindingFetch },
    DEV_WS_DO_URL: "http://dev-ws:8789",
  } as unknown as Env
}

function makeEnvNoBinding(): Env {
  return {
    DEV_WS_DO_URL: "http://dev-ws:8789",
  } as unknown as Env
}

describe("wsDoFetch", () => {
  it("returns the binding response when it is OK (no fallback)", async () => {
    const bindingFetch = vi.fn(async () =>
      new Response("ok", { status: 200 }),
    )
    const env = makeEnv(bindingFetch)
    const res = await wsDoFetch(env, "/x", { method: "POST" })
    expect(res.status).toBe(200)
    expect(bindingFetch).toHaveBeenCalledTimes(1)
    expect(mockFetch).not.toHaveBeenCalled()
    expect(mockWarn).not.toHaveBeenCalled()
    expect(mockInfo).not.toHaveBeenCalled()
    expect(mockError).not.toHaveBeenCalled()
  })

  it("returns the binding response on 4xx WITHOUT calling the HTTP fallback (client-error)", async () => {
    const bindingFetch = vi.fn(async () => new Response("nope", { status: 404 }))
    const env = makeEnv(bindingFetch)
    const res = await wsDoFetch(env, "/x", { method: "POST" }, { label: "L", type: "T" })
    expect(res.status).toBe(404)
    expect(bindingFetch).toHaveBeenCalledTimes(1)
    expect(mockFetch).not.toHaveBeenCalled()
    expect(mockWarn).toHaveBeenCalledTimes(1)
    expect(mockWarn).toHaveBeenCalledWith(
      "broadcast service-binding non-ok (client-error)",
      expect.objectContaining({
        label: "L",
        type: "T",
        path: "/x",
        status: 404,
      }),
    )
  })

  it("falls through to HTTP when the binding throws", async () => {
    const bindingFetch = vi.fn(async () => {
      throw new Error("binding missing")
    })
    mockFetch.mockResolvedValue(new Response("ok", { status: 200 }))
    const env = makeEnv(bindingFetch)
    const res = await wsDoFetch(env, "/x", { method: "POST" })
    expect(res.status).toBe(200)
    expect(bindingFetch).toHaveBeenCalledTimes(1)
    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(String(mockFetch.mock.calls[0][0])).toBe("http://dev-ws:8789/x")
    expect(mockWarn).toHaveBeenCalledWith(
      "broadcast service-binding threw, falling back",
      expect.objectContaining({ path: "/x", err: expect.stringContaining("binding missing") }),
    )
  })

  it("falls through to HTTP when the binding returns 5xx and logs 'recovered' when fallback succeeds", async () => {
    const bindingFetch = vi.fn(async () => new Response("boom", { status: 502 }))
    mockFetch.mockResolvedValue(new Response("ok", { status: 200 }))
    const env = makeEnv(bindingFetch)
    const res = await wsDoFetch(env, "/x", { method: "POST" }, { label: "L", type: "T" })
    expect(res.status).toBe(200)
    expect(bindingFetch).toHaveBeenCalledTimes(1)
    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(String(mockFetch.mock.calls[0][0])).toBe("http://dev-ws:8789/x")
    expect(mockInfo).toHaveBeenCalledWith(
      "broadcast HTTP fallback recovered",
      expect.objectContaining({ label: "L", type: "T", path: "/x" }),
    )
  })

  it("emits the observability warn line with label/type/path/status on binding non-OK (5xx)", async () => {
    const bindingFetch = vi.fn(async () => new Response("bad", { status: 503 }))
    mockFetch.mockResolvedValue(new Response("ok", { status: 200 }))
    const env = makeEnv(bindingFetch)
    await wsDoFetch(env, "/presence/users", { method: "POST" }, { label: "srv_1", type: "presence" })
    expect(mockWarn).toHaveBeenCalledWith(
      "broadcast service-binding non-ok",
      expect.objectContaining({
        label: "srv_1",
        type: "presence",
        path: "/presence/users",
        status: 503,
      }),
    )
  })

  it("does not log the observability warn when the binding is OK", async () => {
    const bindingFetch = vi.fn(async () => new Response("ok", { status: 200 }))
    const env = makeEnv(bindingFetch)
    await wsDoFetch(env, "/x", { method: "POST" }, { label: "L", type: "T" })
    expect(mockWarn).not.toHaveBeenCalled()
  })

  it("logs error and rethrows when binding throws AND HTTP fallback throws", async () => {
    const bindingFetch = vi.fn(async () => {
      throw new Error("binding missing")
    })
    mockFetch.mockRejectedValue(new Error("network down"))
    const env = makeEnv(bindingFetch)
    await expect(
      wsDoFetch(env, "/x", { method: "POST" }, { label: "L", type: "T" }),
    ).rejects.toThrow("network down")
    expect(mockError).toHaveBeenCalledWith(
      "broadcast HTTP fallback threw",
      expect.objectContaining({
        label: "L",
        type: "T",
        path: "/x",
        url: "http://dev-ws:8789",
        err: expect.stringContaining("network down"),
      }),
    )
  })

  it("logs error when binding is 5xx and HTTP fallback returns non-OK", async () => {
    const bindingFetch = vi.fn(async () => new Response("boom", { status: 502 }))
    mockFetch.mockResolvedValue(new Response("still bad", { status: 500 }))
    const env = makeEnv(bindingFetch)
    const res = await wsDoFetch(env, "/x", { method: "POST" }, { label: "L", type: "T" })
    expect(res.status).toBe(500)
    expect(mockError).toHaveBeenCalledWith(
      "broadcast HTTP fallback non-ok",
      expect.objectContaining({
        label: "L",
        type: "T",
        path: "/x",
        status: 500,
        url: "http://dev-ws:8789",
      }),
    )
  })

  it("skips the binding attempt entirely when WS_DO_WORKER is absent and returns fallback OK", async () => {
    mockFetch.mockResolvedValue(new Response("ok", { status: 200 }))
    const env = makeEnvNoBinding()
    const res = await wsDoFetch(env, "/x", { method: "POST" })
    expect(res.status).toBe(200)
    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(mockWarn).not.toHaveBeenCalled()
    // No binding attempt → no "recovered" info line either.
    expect(mockInfo).not.toHaveBeenCalled()
  })

  it("logs error and rethrows when no binding and HTTP fallback throws", async () => {
    mockFetch.mockRejectedValue(new Error("dns fail"))
    const env = makeEnvNoBinding()
    await expect(wsDoFetch(env, "/x", { method: "POST" })).rejects.toThrow("dns fail")
    expect(mockError).toHaveBeenCalledWith(
      "broadcast HTTP fallback threw",
      expect.objectContaining({ path: "/x", err: expect.stringContaining("dns fail") }),
    )
  })
})

describe("broadcastToUser", () => {
  it("routes through wsDoFetch and falls back to HTTP on binding 502 (message not silently dropped)", async () => {
    const bindingFetch = vi.fn(async () => new Response("boom", { status: 502 }))
    mockFetch.mockResolvedValue(new Response(JSON.stringify({ sent: 1 }), { status: 200 }))
    const env = makeEnv(bindingFetch)
    mockGetCloudflareContext.mockReturnValue({
      env,
      ctx: { waitUntil: mockCtxWaitUntil },
    })

    await broadcastToUser("u1", { type: "message:new" } as any)

    expect(bindingFetch).toHaveBeenCalledTimes(1)
    expect(mockFetch).toHaveBeenCalledTimes(1)
    // The observability line must fire with the label (userId) + type + status.
    expect(mockWarn).toHaveBeenCalledWith(
      "broadcast service-binding non-ok",
      expect.objectContaining({
        label: "u1",
        type: "message:new",
        path: "/broadcast/user/u1",
        status: 502,
      }),
    )
  })

  it("does not throw when the binding returns OK", async () => {
    const bindingFetch = vi.fn(async () =>
      new Response(JSON.stringify({ sent: 1 }), { status: 200 }),
    )
    const env = makeEnv(bindingFetch)
    mockGetCloudflareContext.mockReturnValue({
      env,
      ctx: { waitUntil: mockCtxWaitUntil },
    })

    const message = { type: "message:new", raw: "unchanged" } as any
    await expect(broadcastToUser("u1", message)).resolves.toBeUndefined()
    expect(String(bindingFetch.mock.calls[0]?.[0])).toBe("http://internal/broadcast/user/u1")
    expect(bindingFetch.mock.calls[0]?.[1]?.body).toBe(JSON.stringify(message))
    expect(mockFetch).not.toHaveBeenCalled()
    expect(mockWarn).not.toHaveBeenCalled()
  })

  it.each(["用户/one", ".", "..", "%2E"])(
    "encodes and routes community events through the framed strict user endpoint for %j",
    async (target) => {
    const bindingFetch = vi.fn(async () => Response.json({ sent: 1 }))
    mockGetCloudflareContext.mockReturnValue({
      env: makeEnv(bindingFetch),
      ctx: { waitUntil: mockCtxWaitUntil },
    })

    await broadcastToUser(target, communityEvent)

    expect(String(bindingFetch.mock.calls[0]?.[0])).toBe(
      `http://internal/broadcast/community/user/u:${encodeURIComponent(target)}`,
    )
    expect(JSON.parse(String(bindingFetch.mock.calls[0]?.[1]?.body))).toEqual({
      ...communityEvent,
      contractVersion: 1,
    })
    },
  )

  it("rejects invalid community targets and payloads before transport", async () => {
    const bindingFetch = vi.fn(async () => Response.json({ sent: 1 }))
    mockGetCloudflareContext.mockReturnValue({
      env: makeEnv(bindingFetch),
      ctx: { waitUntil: mockCtxWaitUntil },
    })

    await expect(broadcastToUser("x".repeat(129), communityEvent)).rejects.toThrow(
      "invalid community broadcast target",
    )
    await expect(broadcastToUser("u1", {
      type: "community:presence.update",
      userId: "event-user",
    } as any)).rejects.toThrow("invalid community event")
    await expect(broadcastToUser("u1", {
      type: "community:future",
      payload: "private",
    } as any)).rejects.toThrow("invalid community event")
    expect(bindingFetch).not.toHaveBeenCalled()
  })

  it.each(["\ud800", "\udfff"])(
    "rejects malformed Unicode target %# through the Promise without escaping or transport",
    async (target) => {
      const bindingFetch = vi.fn(async () => Response.json({ sent: 1 }))
      mockGetCloudflareContext.mockReturnValue({
        env: makeEnv(bindingFetch),
        ctx: { waitUntil: mockCtxWaitUntil },
      })
      let work!: Promise<void>

      expect(() => {
        work = broadcastToUser(target, communityEvent)
      }).not.toThrow()
      await expect(work).rejects.toThrow("invalid community broadcast target")
      expect(bindingFetch).not.toHaveBeenCalled()
      expect(mockFetch).not.toHaveBeenCalled()
    },
  )

  it.each([
    { type: "task.updated", taskId: "t1", agentId: "a1", status: "running" },
    { type: "email.received", agentId: "a1" },
    { type: "runtime.status", daemonId: "d1", status: "online" },
  ] as const)("preserves generic $type serialization and route selection", async (message) => {
    const bindingFetch = vi.fn(async () => Response.json({ sent: 1 }))
    mockGetCloudflareContext.mockReturnValue({
      env: makeEnv(bindingFetch),
      ctx: { waitUntil: mockCtxWaitUntil },
    })

    await broadcastToUser("generic-user", message)

    expect(String(bindingFetch.mock.calls[0]?.[0])).toBe("http://internal/broadcast/user/generic-user")
    expect(bindingFetch.mock.calls[0]?.[1]?.body).toBe(JSON.stringify(message))
  })
})

describe("broadcastToUsers", () => {
  function setBinding(bindingFetch: (...args: unknown[]) => Promise<Response>): void {
    mockGetCloudflareContext.mockReturnValue({
      env: makeEnv(bindingFetch),
      ctx: { waitUntil: mockCtxWaitUntil },
    })
  }

  function bodiesOf(bindingFetch: ReturnType<typeof vi.fn>): Array<{
    userIds: string[]
    message: Record<string, unknown>
    excludeUserId?: string
  }> {
    return bindingFetch.mock.calls.map((call) => JSON.parse(String(call[1]?.body)))
  }

  function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void
    let reject!: (reason?: unknown) => void
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise
      reject = rejectPromise
    })
    return { promise, resolve, reject }
  }

  it("keeps non-community bulk events on the generic bulk route unchanged", async () => {
    const bindingFetch = vi.fn(async () => Response.json({ sent: 2 }))
    setBinding(bindingFetch)
    const message = { type: "task.updated", taskId: "t1", agentId: "a1", status: "running" } as const

    await broadcastToUsers(["u1", "u2"], message)

    expect(String(bindingFetch.mock.calls[0]?.[0])).toBe("http://internal/broadcast/users")
    expect(JSON.parse(String(bindingFetch.mock.calls[0]?.[1]?.body))).toEqual({
      userIds: ["u1", "u2"],
      message,
    })
  })

  it("does not call transport for an empty post-filter audience and logs zero completion", async () => {
    const bindingFetch = vi.fn(async () => new Response("unused"))
    setBinding(bindingFetch)

    await expect(broadcastToUsers(["u1", "u1"], communityEvent, "u1"))
      .resolves.toBeUndefined()

    expect(bindingFetch).not.toHaveBeenCalled()
    expect(mockFetch).not.toHaveBeenCalled()
    expect(mockCtxWaitUntil).toHaveBeenCalledTimes(1)
    expect(mockInfo).toHaveBeenCalledWith(
      "broadcast_users_complete",
      expect.objectContaining({
        inputCount: 2,
        uniqueCount: 1,
        excludedCount: 1,
        targetCount: 0,
        chunkCount: 0,
        transportSuccessChunkCount: 0,
        transportFailureChunkCount: 0,
        sent: 0,
        maxActive: 0,
        durationMs: expect.any(Number),
      }),
    )
  })

  it.each([
    [1, [1]],
    [1000, [1000]],
    [1001, [1000, 1]],
    [2001, [1000, 1000, 1]],
  ])("chunks %i targets into valid ordered requests", async (targetCount, expectedSizes) => {
    const bindingFetch = vi.fn(async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { userIds: string[] }
      return Response.json({ sent: body.userIds.length })
    })
    setBinding(bindingFetch)
    const userIds = Array.from({ length: targetCount }, (_, index) => `u${index}`)
    const message = communityEvent

    await broadcastToUsers(userIds, message)

    const bodies = bodiesOf(bindingFetch)
    expect(bodies.map((body) => body.userIds.length)).toEqual(expectedSizes)
    expect(bodies.flatMap((body) => body.userIds)).toEqual(userIds)
    expect(bodies.every((body) => body.excludeUserId === undefined)).toBe(true)
    expect(bindingFetch.mock.calls.every((call) => (
      String(call[0]) === "http://internal/broadcast/community/users"
      && call[1]?.method === "POST"
      && JSON.stringify(call[1]?.headers) === JSON.stringify({ "Content-Type": "application/json" })
    ))).toBe(true)
    expect(mockInfo).toHaveBeenCalledWith(
      "broadcast_users_complete",
      expect.objectContaining({
        target: `users:${targetCount}`,
        targetCount,
        chunkCount: expectedSizes.length,
        transportSuccessChunkCount: expectedSizes.length,
        transportFailureChunkCount: 0,
        sent: targetCount,
        maxActive: Math.min(expectedSizes.length, 3),
        durationMs: expect.any(Number),
      }),
    )
  })

  it("dedupes in first-seen order before exclusion and never reintroduces excluded duplicates across chunks", async () => {
    const bindingFetch = vi.fn(async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { userIds: string[] }
      return Response.json({ sent: body.userIds.length })
    })
    setBinding(bindingFetch)
    const expected = Array.from({ length: 1001 }, (_, index) => `target-${index}`)
    const userIds = [
      expected[0],
      "excluded-user",
      expected[0],
      ...expected.slice(1, 1000),
      "excluded-user",
      expected[500],
      expected[1000],
      "excluded-user",
    ]
    const message = communityEvent

    await broadcastToUsers(userIds, message, "excluded-user")

    const bodies = bodiesOf(bindingFetch)
    expect(bodies.map((body) => body.userIds.length)).toEqual([1000, 1])
    expect(bodies.flatMap((body) => body.userIds)).toEqual(expected)
    expect(bodies.every((body) => body.excludeUserId === "excluded-user")).toBe(true)
    expect(bodies.flatMap((body) => body.userIds)).not.toContain("excluded-user")
  })

  it("starts at most three chunks and registers the whole aggregate lifetime", async () => {
    const gates = Array.from({ length: 5 }, () => deferred<Response>())
    let started = 0
    let active = 0
    let observedMaxActive = 0
    const bindingFetch = vi.fn(async () => {
      const index = started
      started += 1
      active += 1
      observedMaxActive = Math.max(observedMaxActive, active)
      const response = await gates[index].promise
      active -= 1
      return response
    })
    setBinding(bindingFetch)
    const work = broadcastToUsers(
      Array.from({ length: 4001 }, (_, index) => `u${index}`),
      communityEvent,
    )
    const lifetime = mockCtxWaitUntil.mock.calls[0]?.[0] as Promise<void>
    let lifetimeSettled = false
    void lifetime.then(() => {
      lifetimeSettled = true
    })

    expect(started).toBe(3)
    expect(observedMaxActive).toBe(3)
    expect(lifetimeSettled).toBe(false)

    gates[1].resolve(Response.json({ sent: 1000 }))
    await vi.waitFor(() => expect(started).toBe(4))
    expect(observedMaxActive).toBe(3)
    expect(lifetimeSettled).toBe(false)

    gates[0].resolve(Response.json({ sent: 1000 }))
    await vi.waitFor(() => expect(started).toBe(5))
    expect(observedMaxActive).toBe(3)

    gates[2].resolve(Response.json({ sent: 1000 }))
    gates[3].resolve(Response.json({ sent: 1000 }))
    gates[4].resolve(Response.json({ sent: 1 }))
    await expect(work).resolves.toBeUndefined()
    await expect(lifetime).resolves.toBeUndefined()
    expect(lifetimeSettled).toBe(true)
  })

  it("isolates a failed chunk, continues later chunks, logs transport counts, then rejects", async () => {
    let callIndex = 0
    const bindingFetch = vi.fn(async (_input: unknown, init?: RequestInit) => {
      const index = callIndex
      callIndex += 1
      if (index === 1) return new Response("bad request", { status: 400 })
      const body = JSON.parse(String(init?.body)) as { userIds: string[] }
      return Response.json({ sent: body.userIds.length })
    })
    setBinding(bindingFetch)
    const work = broadcastToUsers(
      Array.from({ length: 4001 }, (_, index) => `u${index}`),
      communityEvent,
    )

    await expect(work).rejects.toThrow("broadcast failed for 1 of 5 chunks")

    expect(bindingFetch).toHaveBeenCalledTimes(5)
    expect(bodiesOf(bindingFetch).map((body) => body.userIds.length)).toEqual([1000, 1000, 1000, 1000, 1])
    expect(mockWarn).toHaveBeenCalledWith(
      "broadcast_users_chunk_complete",
      expect.objectContaining({
        target: "users:4001",
        chunkNumber: 2,
        chunkCount: 5,
        chunkSize: 1000,
        transportStatus: "failure",
        durationMs: expect.any(Number),
      }),
    )
    expect(mockInfo).toHaveBeenCalledWith(
      "broadcast_users_complete",
      expect.objectContaining({
        transportSuccessChunkCount: 4,
        transportFailureChunkCount: 1,
        sent: 3001,
        maxActive: 3,
      }),
    )
  })

  it("logs only safe target and chunk metadata, not user ids or message secrets", async () => {
    const bindingFetch = vi.fn(async () => Response.json({ sent: 1 }))
    setBinding(bindingFetch)

    await broadcastToUsers(
      ["sensitive-user-id"],
      {
        type: "community:status.update",
        userId: "event-user",
        statusEmoji: null,
        statusText: "private-token-value",
      },
    )

    const newLogCalls = [...mockInfo.mock.calls, ...mockWarn.mock.calls]
      .filter(([message]) => String(message).startsWith("broadcast_users_"))
    const serialized = JSON.stringify(newLogCalls)
    expect(serialized).not.toContain("sensitive-user-id")
    expect(serialized).not.toContain("private-token-value")
    expect(serialized).not.toContain("userIds")
    expect(newLogCalls).toEqual(expect.arrayContaining([
      ["broadcast_users_chunk_complete", expect.objectContaining({
        target: "users:1",
        chunkNumber: 1,
        chunkCount: 1,
        chunkSize: 1,
        transportStatus: "success",
        sent: 1,
        durationMs: expect.any(Number),
      })],
      ["broadcast_users_complete", expect.objectContaining({
        target: "users:1",
        transportSuccessChunkCount: 1,
        transportFailureChunkCount: 0,
      })],
    ]))
  })

  it("falls back exactly once after one binding 5xx", async () => {
    const bindingFetch = vi.fn(async () => new Response("boom", { status: 502 }))
    mockFetch.mockResolvedValue(new Response(JSON.stringify({ sent: 2 }), { status: 200 }))
    setBinding(bindingFetch)

    await broadcastToUsers(["u1", "u2"], communityEvent)

    expect(bindingFetch).toHaveBeenCalledTimes(1)
    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(String(mockFetch.mock.calls[0]?.[0])).toBe("http://dev-ws:8789/broadcast/community/users")
  })

  it("falls back exactly once after one binding throw", async () => {
    const bindingFetch = vi.fn(async () => {
      throw new Error("binding down")
    })
    mockFetch.mockResolvedValue(new Response(JSON.stringify({ sent: 2 }), { status: 200 }))
    setBinding(bindingFetch)

    await broadcastToUsers(["u1", "u2"], communityEvent)

    expect(bindingFetch).toHaveBeenCalledTimes(1)
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })
})
