/**
 * Transport-only producer for already planned committed-message queue tasks.
 * Audience, policy, readability, cursor, and bot selection stay in the
 * committed-message dispatcher.
 */
import { getCloudflareContext } from "@opennextjs/cloudflare"
import { createLogger, type AlookQueueTask } from "@alook/shared"
import { createDevHttpQueueTransport, createQueueTransport } from "./queue-transport"
import type { QueueTransport } from "./queue-transport"

const log = createLogger({ service: "community-queue-producer" })
const QUEUE_BATCH_SIZE = 100

function selectQueueTransport(env: Env): QueueTransport {
  return process.env.NODE_ENV === "development"
    ? createDevHttpQueueTransport(env)
    : createQueueTransport(env.TASK_QUEUE)
}

async function sendQueueTasks(env: Env, tasks: AlookQueueTask[]): Promise<void> {
  if (tasks.length === 0) return
  const transport = selectQueueTransport(env)
  const chunks: AlookQueueTask[][] = []
  for (let index = 0; index < tasks.length; index += QUEUE_BATCH_SIZE) {
    chunks.push(tasks.slice(index, index + QUEUE_BATCH_SIZE))
  }
  const results = await Promise.allSettled(chunks.map((chunk) => transport.send(chunk)))
  const failures = results.filter((result) => result.status === "rejected")
  if (failures.length > 0) {
    log.warn("queue_batch_delivery_failed", {
      chunkCount: chunks.length,
      failedChunkCount: failures.length,
      taskCount: tasks.length,
    })
    throw new Error(`queue delivery failed for ${failures.length} chunk(s)`)
  }
}

export function enqueueQueueTasks(tasks: AlookQueueTask[]): Promise<void> {
  const { env } = getCloudflareContext()
  return sendQueueTasks(env as Env, tasks)
}
