import { createLogger, DEV_WAKE_WORKER_URL } from "@alook/shared"
import type { WakePayload } from "@alook/shared"
import { fetchViaBindingOrDevFallback } from "../dev-binding-fetch"

const log = createLogger({ service: "wake-transport" })

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
      if (!res.ok) {
        throw new Error(`dev wake transport: alook-wake-worker responded ${res.status}`)
      }
    },
  }
}
