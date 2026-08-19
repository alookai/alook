/**
 * Transport-only producer for already planned committed-message wake targets.
 * Audience, policy, readability, cursor, and bot selection live in the
 * committed-message dispatcher; this seam only chunks stable minimal payloads
 * onto the environment-appropriate transport.
 */
import { getCloudflareContext } from "@opennextjs/cloudflare"
import { createLogger, type WakePayload } from "@alook/shared"
import { createDevHttpWakeTransport, createQueueWakeTransport } from "./wake-transport"
import type { WakeTransport } from "./wake-transport"

const log = createLogger({ service: "community-wake-producer" })
const WAKE_BATCH_SIZE = 100

function selectWakeTransport(env: Env): WakeTransport {
  return process.env.NODE_ENV === "development"
    ? createDevHttpWakeTransport(env)
    : createQueueWakeTransport(env.WAKE_QUEUE)
}

async function sendWakePayloads(env: Env, payloads: WakePayload[]): Promise<void> {
  if (payloads.length === 0) return
  const transport = selectWakeTransport(env)
  const chunks: WakePayload[][] = []
  for (let index = 0; index < payloads.length; index += WAKE_BATCH_SIZE) {
    chunks.push(payloads.slice(index, index + WAKE_BATCH_SIZE))
  }
  const results = await Promise.allSettled(chunks.map((chunk) => transport.send(chunk)))
  const failures = results.filter((result) => result.status === "rejected")
  if (failures.length > 0) {
    log.warn("wake_batch_delivery_failed", {
      chunkCount: chunks.length,
      failedChunkCount: failures.length,
      payloadCount: payloads.length,
    })
    throw new Error(`wake delivery failed for ${failures.length} chunk(s)`)
  }
}

export function enqueueBotWakePayloads(payloads: WakePayload[]): Promise<void> {
  const { env } = getCloudflareContext()
  return sendWakePayloads(env as Env, payloads)
}
