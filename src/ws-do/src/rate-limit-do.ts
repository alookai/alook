import { DurableObject } from "cloudflare:workers"
import { AUTOMATION_PERMISSION_LIMITS } from "@alook/shared"

// One DO per policy/key keeps admission atomic. Automation uses rolling windows;
// general policies use caller-supplied fixed windows.

type WindowState = { count: number; windowStart: number }

const STATE_KEY = "state"

export type RateLimitResult =
  | { allowed: true }
  | { allowed: false; retryAfterSec: number }

export class RateLimitDurableObject extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === "/check-automation" && request.method === "POST") {
      let body: unknown
      try { body = await request.json() } catch { return new Response("invalid json", { status: 400 }) }
      const { max, period } = (body ?? {}) as { max?: unknown; period?: unknown }
      if ((period !== "hour" && period !== "day") || typeof max !== "number" || !Number.isInteger(max) || max < 1 || max > AUTOMATION_PERMISSION_LIMITS[period]) {
        return new Response("invalid automation policy", { status: 400 })
      }
      return Response.json(await this.checkAutomation(max, period))
    }

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

  private async checkAutomation(max: number, period: "hour" | "day"): Promise<RateLimitResult> {
    return this.ctx.storage.transaction(async (transaction) => {
      const now = Date.now()
      const hour = 3_600_000
      const timestamps = (await transaction.get<number[]>("automation")) ?? []
      const day = timestamps.filter((time) => time > now - 24 * hour)
      const recentHour = day.filter((time) => time > now - hour)
      const configured = period === "hour" ? recentHour : day
      let retryMs = 0
      if (recentHour.length >= AUTOMATION_PERMISSION_LIMITS.hour) retryMs = recentHour[recentHour.length - AUTOMATION_PERMISSION_LIMITS.hour]! + hour - now
      if (configured.length >= max) retryMs = Math.max(retryMs, configured[configured.length - max]! + (period === "hour" ? hour : 24 * hour) - now)
      if (retryMs > 0) return { allowed: false, retryAfterSec: Math.max(1, Math.ceil(retryMs / 1000)) }
      day.push(now)
      await transaction.put("automation", day)
      return { allowed: true }
    })
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
