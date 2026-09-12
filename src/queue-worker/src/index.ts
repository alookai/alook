import {
  createLogger,
  createDb,
  parseQueueTask,
  parseQueueTaskBatch,
} from "@alook/shared"
import type { AlookQueueTask, Database } from "@alook/shared"
import { executeQueueTask } from "./task-handler"

const log = createLogger({ service: "queue-worker" })
const DEV_HTTP_MAX_ATTEMPTS = 3
const DEV_HTTP_RETRY_DELAYS_MS = [25, 100] as const

/**
 * Deduplicate one batch by its stable task tuple. Both production Queue and
 * the dev-only HTTP shim execute the same normalized task handler.
 */
function dedupeQueueTasks(tasks: AlookQueueTask[]): AlookQueueTask[] {
  const seen = new Set<string>()
  return tasks.filter((task) => {
    const recipientId = task.kind === "bot-wake" ? task.botUserId : task.userId
    const key = JSON.stringify([task.kind, task.messageId, recipientId])
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

async function waitForDevHttpRetry(delayMs: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs))
}

async function resolveDevHttpTask(db: Database, env: Env, task: AlookQueueTask): Promise<boolean> {
  for (let retryIndex = 0; retryIndex < DEV_HTTP_RETRY_DELAYS_MS.length; retryIndex++) {
    try {
      await executeQueueTask(db, env, task)
      return true
    } catch (err) {
      const attempt = retryIndex + 1
      const delayMs = DEV_HTTP_RETRY_DELAYS_MS[retryIndex]!
      log.warn("dev_http_queue_task_retrying", {
        kind: task.kind,
        messageId: task.messageId,
        attempt,
        delayMs,
        errorName: err instanceof Error ? err.name : "unknown",
      })
      await waitForDevHttpRetry(delayMs)
    }
  }

  try {
    await executeQueueTask(db, env, task)
    return true
  } catch (err) {
    log.warn("dev_http_queue_task_exhausted", {
      kind: task.kind,
      messageId: task.messageId,
      attempts: DEV_HTTP_MAX_ATTEMPTS,
      errorName: err instanceof Error ? err.name : "unknown",
    })
    return false
  }
}

export default {
  /**
   * `alook-queue-worker` — Cloudflare Queue consumer for `alook-queue`
   * (minimal-wake-queue-unread-notice plan §3). Owns a `DB` binding to the
   * same `alook-app` database `src/web` writes to: for every minimal
   * accepted legacy or v1 `bot-wake` queue item, `dispatchOneUnreadWake`
   * re-reads CURRENT D1 state and only then forwards a freshly built
   * `agent:wake` `HostCommand`. This is what keeps a stale queue item from
   * waking an old machine, an already-caught-up bot, or a bot that lost
   * access to the scope since it was enqueued.
   */
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    let db: Database | undefined
    for (const msg of batch.messages) {
      const parsed = parseQueueTask(msg.body)
      if (!parsed.ok) {
        log.warn("queue_task_ignored", { reason: parsed.reason })
        msg.ack()
        continue
      }

      if (!db) db = createDb(env.DB)
      try {
        await executeQueueTask(db, env, parsed.task)
        msg.ack()
      } catch (err) {
        // Transient failure (D1 exception, 5xx / network) — retry with
        // backoff. After `max_retries` (wrangler.toml: 3), the message lands
        // in the DLQ.
        log.warn("bot_wake_failed_retrying", {
          kind: parsed.task.kind,
          messageId: parsed.task.messageId,
          errorName: err instanceof Error ? err.name : "unknown",
        })
        msg.retry({ delaySeconds: 5 })
      }
    }
  },

  /**
   * Dev-only HTTP stand-in for the local Cloudflare Queue. Local Queues
   * simulation cannot bridge separate `wrangler dev`/`next dev` processes
   * (plans/minimal-wake-queue-unread-notice.md), so `src/web`'s
   * `queue-transport.ts` calls this route (via the `QUEUE_WORKER` service
   * binding, `NODE_ENV === "development"` only) instead of
   * `TASK_QUEUE.sendBatch(...)`. Body is a JSON array of accepted legacy or
   * v1 queue tasks. Runs the same handler as `queue()`, including current-D1
   * revalidation and, for bot wakes, the real forward to `alook-ws-do`.
   * There is no durable queue behind this dev path:
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

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return new Response("invalid json body", { status: 400 })
    }

    const parsed = parseQueueTaskBatch(body)
    if (!parsed.ok) return new Response("invalid queue payload", { status: 400 })
    if (parsed.tasks.length === 0) return new Response(null, { status: 202 })

    const db = createDb(env.DB)
    const uniqueTasks = dedupeQueueTasks(parsed.tasks)
    const results = await Promise.all(
      uniqueTasks.map(async (task) => ({
        task,
        resolved: await resolveDevHttpTask(db, env, task),
      })),
    )
    const failed = results.filter((result) => !result.resolved).map((result) => result.task)
    if (failed.length > 0) return Response.json({ failed }, { status: 207 })

    return new Response(null, { status: 202 })
  },
} satisfies ExportedHandler<Env>
