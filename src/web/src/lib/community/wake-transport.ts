import { createLogger, DEV_WAKE_WORKER_URL } from "@alook/shared"
import type { WakePayload } from "@alook/shared"
import { fetchViaBindingOrDevFallback } from "../dev-binding-fetch"

const log = createLogger({ service: "wake-transport" })

function isExactFailedCandidate(value: unknown): value is WakePayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const keys = Object.keys(value)
  if (keys.length !== 2 || !keys.includes("messageId") || !keys.includes("botUserId")) return false
  const candidate = value as Record<string, unknown>
  return typeof candidate.messageId === "string"
    && candidate.messageId.length > 0
    && typeof candidate.botUserId === "string"
    && candidate.botUserId.length > 0
}

function parsePartialFailure(value: unknown, payloads: WakePayload[]): WakePayload[] | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null
  const keys = Object.keys(value)
  if (keys.length !== 1 || keys[0] !== "failed") return null

  const failed = (value as Record<string, unknown>).failed
  if (!Array.isArray(failed) || failed.length === 0 || !failed.every(isExactFailedCandidate)) return null

  const allowed = new Map<string, Set<string>>()
  for (const item of payloads) {
    let botIds = allowed.get(item.messageId)
    if (!botIds) {
      botIds = new Set<string>()
      allowed.set(item.messageId, botIds)
    }
    botIds.add(item.botUserId)
  }

  const seen = new Map<string, Set<string>>()
  for (const item of failed) {
    if (!allowed.get(item.messageId)?.has(item.botUserId)) return null
    let botIds = seen.get(item.messageId)
    if (!botIds) {
      botIds = new Set<string>()
      seen.set(item.messageId, botIds)
    }
    if (botIds.has(item.botUserId)) return null
    botIds.add(item.botUserId)
  }

  return failed
}

/**
 * How `enqueueBotWakes` hands a batch of wake candidates off to whatever
 * will actually resolve them. Exactly two implementations below — neither
 * caller (`wake-producer.ts`) ever talks to `WAKE_QUEUE`/`WAKE_WORKER`
 * directly, and neither ever re-implements "rebuild from D1, skip or
 * forward" (that logic lives once, in `@alook/shared`'s
 * `dispatchOneUnreadWake`, and is exercised by whichever transport actually
 * runs it).
 */
export interface WakeTransport {
  send(payloads: WakePayload[]): Promise<void>
}

/** Production (and any non-`development` environment): the real Cloudflare Queue. */
export function createQueueWakeTransport(queue: Queue<WakePayload>): WakeTransport {
  return {
    async send(payloads) {
      await queue.sendBatch(payloads.map((body) => ({ body })))
    },
  }
}

/**
 * Dev-only. Local Cloudflare Queues simulation cannot bridge separate
 * `wrangler dev`/`next dev` processes (plans/minimal-wake-queue-unread-notice.md)
 * — every `WAKE_QUEUE.sendBatch()` call from `next dev` lands nowhere. This
 * transport instead calls the REAL `alook-wake-worker` process directly over
 * HTTP (its `fetch()` dev entrypoint, see `src/wake-worker/src/index.ts`),
 * via the `WAKE_WORKER` service binding with the same binding-first/
 * HTTP-fallback reliability pattern `broadcast.ts` uses for `WS_DO_WORKER`
 * (`next dev`'s `getPlatformProxy` service bindings to separately-run
 * `wrangler dev` workers are not reliably reachable on their own). The
 * candidate then gets resolved by `alook-wake-worker`'s own process, against
 * the real D1 database, with a real forward to `alook-ws-do` — the actual
 * production code path, not a local stand-in for it.
 */
export function createDevHttpWakeTransport(env: Env): WakeTransport {
  return {
    async send(payloads) {
      const res = await fetchViaBindingOrDevFallback(
        env.WAKE_WORKER,
        env.DEV_WAKE_WORKER_URL || DEV_WAKE_WORKER_URL,
        "/",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payloads),
        },
        { logPrefix: "wake_transport", log, label: `${payloads.length}_candidates` },
      )
      if (res.status === 207) {
        let body: unknown
        try {
          body = await res.json()
        } catch {
          throw new Error("dev wake transport: invalid partial response")
        }
        const failed = parsePartialFailure(body, payloads)
        if (!failed) throw new Error("dev wake transport: invalid partial response")
        throw new Error(`dev wake transport partial failure: ${failed.length} candidate(s) exhausted`)
      }
      if (!res.ok) {
        throw new Error(`dev wake transport: alook-wake-worker responded ${res.status}`)
      }
    },
  }
}
