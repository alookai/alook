import { createLogger, DEV_QUEUE_WORKER_URL, parseQueueTask, parseStrictFailedSubset, queueTaskIdentity } from "@alook/shared"
import type { AlookQueueTask } from "@alook/shared"
import { fetchViaBindingOrDevFallback } from "../dev-binding-fetch"

const log = createLogger({ service: "queue-transport" })

function isExactFailedCandidate(value: unknown): value is AlookQueueTask {
  return parseQueueTask(value).ok
}

function parsePartialFailure(value: unknown, tasks: AlookQueueTask[]): AlookQueueTask[] | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null
  const keys = Object.keys(value)
  if (keys.length !== 1 || keys[0] !== "failed") return null

  return parseStrictFailedSubset(
    (value as Record<string, unknown>).failed,
    tasks,
    {
      isTarget: isExactFailedCandidate,
      key: queueTaskIdentity,
    },
  )
}

/**
 * The committed-message dispatcher hands already-planned versioned tasks to
 * exactly one of these transports. Neither transport owns audience or policy.
 */
export interface QueueTransport {
  send(tasks: AlookQueueTask[]): Promise<void>
}

/** Production (and any non-`development` environment): the real Cloudflare Queue. */
export function createQueueTransport(queue: Queue<AlookQueueTask>): QueueTransport {
  return {
    async send(tasks) {
      await queue.sendBatch(tasks.map((body) => ({ body, contentType: "json" })))
    },
  }
}

/**
 * Dev-only. Local Cloudflare Queues simulation cannot bridge separate
 * `wrangler dev`/`next dev` processes
 * — every cross-process Queue send from `next dev` lands nowhere. This
 * transport instead calls the real `alook-queue-worker` process directly over
 * HTTP (its `fetch()` dev entrypoint, see `src/queue-worker/src/index.ts`),
 * via the `QUEUE_WORKER` service binding with the same binding-first/
 * HTTP-fallback reliability pattern `broadcast.ts` uses for `WS_DO_WORKER`
 * (`next dev`'s `getPlatformProxy` service bindings to separately-run
 * `wrangler dev` workers are not reliably reachable on their own). The
 * task then runs through the same worker task handler as production traffic.
 */
export function createDevHttpQueueTransport(env: Env): QueueTransport {
  return {
    async send(tasks) {
      const res = await fetchViaBindingOrDevFallback(
        env.QUEUE_WORKER,
        env.DEV_QUEUE_WORKER_URL || DEV_QUEUE_WORKER_URL,
        "/",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(tasks),
        },
        { logPrefix: "queue_transport", log, label: `${tasks.length}_tasks` },
      )
      if (res.status === 207) {
        let body: unknown
        try {
          body = await res.json()
        } catch {
          throw new Error("dev queue transport: invalid partial response")
        }
        const failed = parsePartialFailure(body, tasks)
        if (!failed) throw new Error("dev queue transport: invalid partial response")
        throw new Error(`dev queue transport partial failure: ${failed.length} task(s) exhausted`)
      }
      if (!res.ok) {
        throw new Error(`dev queue transport: alook-queue-worker responded ${res.status}`)
      }
    },
  }
}
