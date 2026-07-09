import { createLogger, createDb, dispatchOneUnreadWake } from "@alook/shared"
import type { WakePayload, Database } from "@alook/shared"

const log = createLogger({ service: "wake-worker" })

/**
 * Resolve ONE wake candidate via `dispatchOneUnreadWake` and log its
 * (non-error) outcome. Shared by both entrypoints below — `queue()` (real
 * traffic) and `fetch()` (dev-only stand-in for the local Cloudflare Queue,
 * see its doc comment) — so the log lines and interpretation logic exist
 * exactly once regardless of which entrypoint received the item. Throws
 * propagate untouched; each caller decides retry (queue) vs best-effort
 * (dev HTTP shim) on its own.
 */
async function resolveAndLog(db: Database, env: Env, item: WakePayload) {
  const result = await dispatchOneUnreadWake(db, env, item)
  if (result.outcome === "skip") {
    // Every skip reason is a permanent current-state miss — caller must ack, never retry.
    log.info("wake_skipped", { botUserId: item.botUserId, messageId: item.messageId, reason: result.reason })
  } else if (result.outcome === "delivered_nowhere") {
    // ws-do resolved cleanly but the daemon is offline — a known-permanent
    // state for this attempt (plan §3's error contract). Daemon reconnect
    // warmup recovers; retrying would just spin, so this also acks.
    log.info("wake_delivered_nowhere", { botUserId: item.botUserId, machineId: result.machineId })
  }
  return result
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
   * not a simulation of it. Best-effort: no queue infra backs this, so one
   * candidate's failure is logged but never blocks siblings or the response.
   */
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST") return new Response("method not allowed", { status: 405 })

    let payloads: WakePayload[]
    try {
      payloads = await request.json()
    } catch {
      return new Response("invalid json body", { status: 400 })
    }

    const db = createDb(env.DB)
    const results = await Promise.allSettled(payloads.map((p) => resolveAndLog(db, env, p)))
    for (let i = 0; i < results.length; i++) {
      const r = results[i]!
      if (r.status === "rejected") {
        log.warn("dev_http_wake_dispatch_failed", { botUserId: payloads[i]!.botUserId, messageId: payloads[i]!.messageId, err: String(r.reason) })
      }
    }
    return new Response(null, { status: 202 })
  },
}
