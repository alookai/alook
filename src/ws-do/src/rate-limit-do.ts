import { DurableObject } from "cloudflare:workers"
import { AUTOMATION_PERMISSION_LIMITS } from "@alook/shared"

// One DO per policy/key keeps admission atomic. Automation uses rolling windows;
// general policies use caller-supplied fixed windows.

type WindowState = { count: number; windowStart: number; windowEnd?: number }

const STATE_KEY = "state"
const AUTOMATION_KEY = "automation"
const AUTOMATION_HOUR_MS = 3_600_000
const AUTOMATION_DAY_MS = 24 * AUTOMATION_HOUR_MS

export type RateLimitResult =
  | { allowed: true }
  | { allowed: false; retryAfterSec: number }

export class RateLimitDurableObject extends DurableObject<Env> {
  private async scheduleCleanupAlarm(
    storage: DurableObjectStorage | DurableObjectTransaction,
    expiresAtMs: number,
  ): Promise<void> {
    const currentAlarm = await storage.getAlarm()
    if (currentAlarm === null || currentAlarm < expiresAtMs) {
      await storage.setAlarm(expiresAtMs)
    }
  }

  async alarm(): Promise<void> {
    const now = Date.now()
    const shouldDeleteAll = await this.ctx.storage.transaction(async (transaction) => {
      const state = (await transaction.get<WindowState>(STATE_KEY)) ?? null
      const timestamps = (await transaction.get<number[]>(AUTOMATION_KEY)) ?? null

      let nextExpiry: number | null = null
      let stateActive = false
      if (state) {
        if (state.windowEnd !== undefined && now >= state.windowEnd) {
          await transaction.delete(STATE_KEY)
        } else {
          stateActive = true
          if (state.windowEnd !== undefined) {
            nextExpiry = state.windowEnd
          }
        }
      }

      let automationActive = false
      if (timestamps !== null) {
        const recentDay = timestamps.filter((time) => time > now - AUTOMATION_DAY_MS)
        if (recentDay.length === 0) {
          await transaction.delete(AUTOMATION_KEY)
        } else {
          automationActive = true
          if (recentDay.length !== timestamps.length) {
            await transaction.put(AUTOMATION_KEY, recentDay)
          }
          const latestExpiry = recentDay[recentDay.length - 1]! + AUTOMATION_DAY_MS
          nextExpiry = nextExpiry === null ? latestExpiry : Math.max(nextExpiry, latestExpiry)
        }
      }

      if (!stateActive && !automationActive) {
        return true
      }

      if (nextExpiry !== null) {
        await transaction.setAlarm(nextExpiry)
      }
      return false
    })

    if (shouldDeleteAll) {
      await this.ctx.storage.deleteAlarm()
      await this.ctx.storage.deleteAll()
    }
  }

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
      const timestamps = (await transaction.get<number[]>(AUTOMATION_KEY)) ?? []
      const day = timestamps.filter((time) => time > now - AUTOMATION_DAY_MS)
      const recentHour = day.filter((time) => time > now - AUTOMATION_HOUR_MS)
      const configured = period === "hour" ? recentHour : day
      let retryMs = 0
      if (recentHour.length >= AUTOMATION_PERMISSION_LIMITS.hour) retryMs = recentHour[recentHour.length - AUTOMATION_PERMISSION_LIMITS.hour]! + AUTOMATION_HOUR_MS - now
      if (configured.length >= max) retryMs = Math.max(retryMs, configured[configured.length - max]! + (period === "hour" ? AUTOMATION_HOUR_MS : AUTOMATION_DAY_MS) - now)
      if (retryMs > 0) return { allowed: false, retryAfterSec: Math.max(1, Math.ceil(retryMs / 1000)) }
      day.push(now)
      await transaction.put(AUTOMATION_KEY, day)
      await this.scheduleCleanupAlarm(transaction, now + AUTOMATION_DAY_MS)
      return { allowed: true }
    })
  }

  private async check(windowMs: number, max: number): Promise<RateLimitResult> {
    return this.ctx.storage.transaction(async (transaction) => {
      const now = Date.now()
      const state = (await transaction.get<WindowState>(STATE_KEY)) ?? null

      if (!state || now - state.windowStart >= windowMs) {
        const windowEnd = now + windowMs
        await transaction.put<WindowState>(STATE_KEY, { count: 1, windowStart: now, windowEnd })
        await this.scheduleCleanupAlarm(transaction, windowEnd)
        return { allowed: true }
      }

      const windowEnd = state.windowEnd ?? state.windowStart + windowMs
      if (state.count >= max) {
        const retryAfterSec = Math.ceil((state.windowStart + windowMs - now) / 1000)
        return { allowed: false, retryAfterSec: Math.max(retryAfterSec, 1) }
      }

      await transaction.put<WindowState>(STATE_KEY, {
        count: state.count + 1,
        windowStart: state.windowStart,
        windowEnd,
      })
      if (state.windowEnd === undefined) {
        await this.scheduleCleanupAlarm(transaction, windowEnd)
      }
      return { allowed: true }
    })
  }
}
