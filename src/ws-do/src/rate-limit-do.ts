import { DurableObject } from "cloudflare:workers"

/**
 * Strongly-consistent, parameterized rate limiter.
 *
 * Cloudflare KV is eventually consistent (see
 * https://developers.cloudflare.com/kv/concepts/how-kv-works/) and has no
 * atomic read-modify-write, so any counter driven by `get → mutate → put`
 * can leak past its cap under concurrent load. A Durable Object instance
 * is single-threaded and its `ctx.storage` is strongly consistent, which
 * is exactly what a rate limiter needs.
 *
 * Every rate-limit call is a fixed-window counter parameterized by
 * `{ windowMs, max }`. The policy is chosen by the CALLER — see the shared
 * `RATE_LIMITS` registry in `src/shared/src/lib/rate-limits.ts` for the
 * canonical list of policies used across the app. This class is
 * intentionally policy-agnostic: adding a new rate limit means adding a
 * row to that registry, not editing this file.
 *
 * Sharding: one DO instance per key via `idFromName(name + ":" + key)`.
 * Different rate-limit names never collide even when they share a key
 * (e.g. same userId for both `community:msgSend` and `auth:otpSend`).
 *
 * Endpoint:
 *   POST /check
 *     Body: { windowMs: number, max: number }
 *     Response: { allowed: true } | { allowed: false, retryAfterSec: number }
 */

type WindowState = { count: number; windowStart: number }

const STATE_KEY = "state"

export type RateLimitResult =
  | { allowed: true }
  | { allowed: false; retryAfterSec: number }

export class RateLimitDurableObject extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === "/check" && request.method === "POST") {
      let body: unknown
      try {
        body = await request.json()
      } catch {
        return new Response("invalid json", { status: 400 })
      }
      const { windowMs, max } = (body ?? {}) as { windowMs?: unknown; max?: unknown }
      if (
        typeof windowMs !== "number" || !Number.isFinite(windowMs) || windowMs <= 0 ||
        typeof max !== "number" || !Number.isFinite(max) || max <= 0
      ) {
        return new Response("windowMs and max must be positive numbers", { status: 400 })
      }
      return Response.json(await this.check(windowMs, max))
    }

    return new Response("not found", { status: 404 })
  }

  private async check(windowMs: number, max: number): Promise<RateLimitResult> {
    const now = Date.now()
    const state = (await this.ctx.storage.get<WindowState>(STATE_KEY)) ?? null

    if (!state || now - state.windowStart >= windowMs) {
      await this.ctx.storage.put<WindowState>(STATE_KEY, { count: 1, windowStart: now })
      return { allowed: true }
    }

    if (state.count >= max) {
      const retryAfterSec = Math.ceil((state.windowStart + windowMs - now) / 1000)
      return { allowed: false, retryAfterSec: Math.max(retryAfterSec, 1) }
    }

    await this.ctx.storage.put<WindowState>(STATE_KEY, {
      count: state.count + 1,
      windowStart: state.windowStart,
    })
    return { allowed: true }
  }
}
