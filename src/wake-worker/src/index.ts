import { createLogger, createDb, dispatchOneUnreadWake } from "@alook/shared"
import type { WakePayload, Database } from "@alook/shared"

const log = createLogger({ service: "wake-worker" })
const DEV_HTTP_MAX_ATTEMPTS = 3
const DEV_HTTP_RETRY_DELAYS_MS = [25, 100] as const

/**
 * Resolve ONE wake candidate via `dispatchOneUnreadWake` and log its
 * (non-error) outcome. Shared by both entrypoints below — `queue()` (real
 * traffic) and `fetch()` (dev-only stand-in for the local Cloudflare Queue,
 * see its doc comment) — so the log lines and interpretation logic exist
 * exactly once regardless of which entrypoint received the item. Throws
 * propagate untouched; each caller applies its own retry contract (Queue
 * retry/DLQ versus bounded in-process retries for the dev HTTP shim).
 */
async function resolveAndLog(db: Database, env: Env, item: WakePayload) {
  const result = await dispatchOneUnreadWake(db, env, item)
  if (result.outcome === "skip") {
    // Every skip reason is a permanent current-state miss — caller must ack, never retry.
    log.info("wake_skipped", { botUserId: item.botUserId, messageId: item.messageId, reason: result.reason })
  } else if (result.outcome === "attempted_nowhere") {
    // ws-do resolved cleanly but the daemon is offline — a known-permanent
    // state for this attempt (plan §3's error contract). Daemon reconnect
    // warmup recovers; retrying would just spin, so this also acks.
    log.info("wake_attempted_nowhere", { botUserId: item.botUserId, machineId: result.machineId })
  }
  return result
}

function dedupeWakePayloads(payloads: WakePayload[]): WakePayload[] {
  const seen = new Map<string, Set<string>>()
  return payloads.filter((item) => {
    let botIds = seen.get(item.messageId)
    if (!botIds) {
      botIds = new Set<string>()
      seen.set(item.messageId, botIds)
    }
    if (botIds.has(item.botUserId)) return false
    botIds.add(item.botUserId)
    return true
  })
}

async function waitForDevHttpRetry(delayMs: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs))
}

async function resolveDevHttpCandidate(db: Database, env: Env, item: WakePayload): Promise<boolean> {
  for (let attempt = 1; attempt <= DEV_HTTP_MAX_ATTEMPTS; attempt++) {
    try {
      await resolveAndLog(db, env, item)
      return true
    } catch (err) {
      if (attempt === DEV_HTTP_MAX_ATTEMPTS) {
        log.warn("dev_http_wake_dispatch_exhausted", {
          botUserId: item.botUserId,
          messageId: item.messageId,
          attempts: attempt,
          err: String(err),
        })
        return false
      }

      const delayMs = DEV_HTTP_RETRY_DELAYS_MS[attempt - 1]!
      log.warn("dev_http_wake_dispatch_retrying", {
        botUserId: item.botUserId,
        messageId: item.messageId,
        attempt,
        delayMs,
        err: String(err),
      })
      await waitForDevHttpRetry(delayMs)
    }
  }

  return false
}

export default {
  /**
   * `alook-wake-worker` — Cloudflare Queue consumer for `alook-wake`
   * (minimal-wake-queue-unread-notice plan §3). Owns a `DB` binding to the
   * same `alook-app` database `src/web` writes to: for every minimal
   * `{ messageId, botUserId }` queue item, `dispatchOneUnreadWake` re-reads
   * CURRENT D1 state and only then forwards a freshly built `agent:wake`
   * `HostCommand`. This is what keeps a stale queue item from waking an old
   * machine, an already-caught-up bot, or a bot that lost access to the
   * scope since it was enqueued.
   */
  async queue(batch: MessageBatch<WakePayload>, env: Env): Promise<void> {
    const db = createDb(env.DB)
    for (const msg of batch.messages) {
      try {
        await resolveAndLog(db, env, msg.body)
        msg.ack()
      } catch (err) {
        // Transient failure (D1 exception, 5xx / network) — retry with
        // backoff. After `max_retries` (wrangler.toml: 3), the message lands
        // in the DLQ.
        log.warn("wake_dispatch_failed_retrying", {
          botUserId: msg.body.botUserId,
          messageId: msg.body.messageId,
          err: String(err),
        })
        msg.retry({ delaySeconds: 5 })
      }
    }
  },

  /**
   * Dev-only HTTP stand-in for the local Cloudflare Queue. Local Queues
   * simulation cannot bridge separate `wrangler dev`/`next dev` processes
   * (plans/minimal-wake-queue-unread-notice.md), so `src/web`'s
   * `wake-transport.ts` calls this route (via the `WAKE_WORKER` service
   * binding, `NODE_ENV === "development"` only) instead of
   * `WAKE_QUEUE.sendBatch(...)`. Body is a JSON `WakePayload[]` — same shape
   * a queue batch's message bodies would carry. Runs the SAME
   * `resolveAndLog`/`dispatchOneUnreadWake` real orchestration `queue()`
   * does, including the real D1 read and the real forward to `alook-ws-do`
   * — this is the actual worker process handling actual wake candidates,
   * not a simulation of it. There is no durable queue behind this dev path:
   * candidates get bounded in-process retries and exhausted stable keys are
   * returned visibly as a 207 partial result. A partial result is deliberately
   * not a 5xx because the caller's binding/HTTP fallback would otherwise
   * replay the full batch and duplicate already-successful siblings.
   */
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === "/health" && request.method === "GET") {
      return Response.json({ status: "ok" })
    }

    if (request.method !== "POST") return new Response("method not allowed", { status: 405 })

    let payloads: WakePayload[]
    try {
      payloads = await request.json()
    } catch {
      return new Response("invalid json body", { status: 400 })
    }

    const db = createDb(env.DB)
    const uniquePayloads = dedupeWakePayloads(payloads)
    const results = await Promise.all(
      uniquePayloads.map(async (item) => ({ item, resolved: await resolveDevHttpCandidate(db, env, item) })),
    )
    const failed = results.filter((result) => !result.resolved).map((result) => result.item)
    if (failed.length > 0) return Response.json({ failed }, { status: 207 })

    return new Response(null, { status: 202 })
  },
}
