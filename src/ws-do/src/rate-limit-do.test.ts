import { describe, it, expect, vi, beforeEach } from "vitest"
import { createMockCtx } from "./__mocks__/cf"

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

import { RateLimitDurableObject } from "./rate-limit-do"

function makeDO() {
  const mock = createMockCtx()
  const doInstance = new RateLimitDurableObject(mock.ctx, {} as Env)
  return { doInstance, ...mock }
}

async function check(
  doInstance: RateLimitDurableObject,
  windowMs: number,
  max: number,
) {
  const res = await doInstance.fetch(
    new Request("http://internal/check", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ windowMs, max }),
    }),
  )
  return (await res.json()) as { allowed: boolean; retryAfterSec?: number }
}

describe("RateLimitDurableObject", () => {
  beforeEach(() => {
    vi.useRealTimers()
  })

  it("allows the first request when no state exists", async () => {
    const { doInstance } = makeDO()
    expect((await check(doInstance, 10_000, 30)).allowed).toBe(true)
  })

  it("allows up to `max` sends within one window", async () => {
    const { doInstance } = makeDO()
    for (let i = 0; i < 30; i++) {
      expect((await check(doInstance, 10_000, 30)).allowed).toBe(true)
    }
  })

  it("blocks the (max+1)th send with a positive retryAfter", async () => {
    const { doInstance } = makeDO()
    for (let i = 0; i < 30; i++) await check(doInstance, 10_000, 30)
    const blocked = await check(doInstance, 10_000, 30)
    expect(blocked.allowed).toBe(false)
    expect(blocked.retryAfterSec).toBeGreaterThan(0)
  })

  it("honours the caller-supplied window+max — the DO is policy-agnostic", async () => {
    const { doInstance } = makeDO()
    // Different caller with a tiny 3/1s policy
    for (let i = 0; i < 3; i++) {
      expect((await check(doInstance, 1_000, 3)).allowed).toBe(true)
    }
    expect((await check(doInstance, 1_000, 3)).allowed).toBe(false)
  })

  it("resets the window once WINDOW has elapsed", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"))
    const { doInstance } = makeDO()
    for (let i = 0; i < 30; i++) await check(doInstance, 10_000, 30)
    expect((await check(doInstance, 10_000, 30)).allowed).toBe(false)
    vi.advanceTimersByTime(10_001)
    expect((await check(doInstance, 10_000, 30)).allowed).toBe(true)
  })

  it("returns 400 when windowMs/max is missing or non-positive", async () => {
    const { doInstance } = makeDO()
    const res = await doInstance.fetch(
      new Request("http://internal/check", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ windowMs: 0, max: -1 }),
      }),
    )
    expect(res.status).toBe(400)
  })

  it("returns 404 for unknown paths", async () => {
    const { doInstance } = makeDO()
    const res = await doInstance.fetch(
      new Request("http://internal/nope", { method: "POST" }),
    )
    expect(res.status).toBe(404)
  })

  it("persists the counter across DO instances (survives eviction)", async () => {
    const mock = createMockCtx()
    const a = new RateLimitDurableObject(mock.ctx, {} as Env)
    for (let i = 0; i < 30; i++) await check(a, 10_000, 30)
    const b = new RateLimitDurableObject(mock.ctx, {} as Env)
    expect((await check(b, 10_000, 30)).allowed).toBe(false)
  })
})
