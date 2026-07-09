/**
 * Push-wake producer — after a message lands and the human-WS fanout has
 * broadcast it, this filters the fanout's recipient set down to "bots that
 * are actually behind on this scope" and hands one minimal `{ messageId,
 * botUserId }` payload per candidate off to a `WakeTransport`
 * (minimal-wake-queue-unread-notice plan §1/§5). Deliberately carries NO
 * `HostCommand`, `machineId`, runtime, or message content — the consumer
 * (real `alook-wake-worker`, in both transports — see `wake-transport.ts`)
 * rebuilds the `agent:wake` command from CURRENT D1 state at consume time
 * (`dispatchOneUnreadWake`/`buildUnreadWakeCommand`), so a stale item never
 * wakes an old machine or carries stale content.
 *
 * This module owns ONLY "who are the candidates" — it never talks to
 * `WAKE_QUEUE`/`WAKE_WORKER` directly and never re-implements what happens
 * to a candidate. See `wake-transport.ts` for which transport runs in which
 * environment and why (local Cloudflare Queues can't bridge separate
 * `wrangler dev`/`next dev` processes today).
 */
import { getCloudflareContext } from "@opennextjs/cloudflare"
import { queries, createLogger } from "@alook/shared"
import type { WakePayload } from "@alook/shared"
import { getDb } from "../db"
import { createQueueWakeTransport, createDevHttpWakeTransport } from "./wake-transport"
import type { WakeTransport } from "./wake-transport"

const log = createLogger({ service: "community-wake-producer" })

// Cloudflare Queues caps a single `sendBatch` call at 100 messages; kept the
// same batch size for the dev HTTP transport for a uniform code path.
const WAKE_BATCH_SIZE = 100

/**
 * The just-inserted message row — lean, no body/preview (plan §1/§5): only
 * what `findWakeCandidates`' unread filter needs. Must include `seq` (see
 * `getMessage`'s select).
 */
export interface WakeMessageRow {
  id: string
  seq: number
  authorId: string
  channelId: string | null
  dmConversationId: string | null
}

export interface EnqueueBotWakesOpts {
  /** Every fanout recipient (human + bot) — this function does its own bot/unread filtering. */
  recipients: string[]
  channelId?: string
  dmConversationId?: string
  messageRow: WakeMessageRow
}

/**
 * Fire-and-forget from the caller's perspective, but NOT actually
 * fire-and-forget under the hood: this function acquires the Cloudflare
 * context and registers `ctx.waitUntil(...)` synchronously in its own first
 * tick (before any `await`), so the enclosing request's response can be
 * written and the isolate can still be kept alive long enough for the
 * transport call to land. Callers MUST invoke this before the response is
 * sent (same requirement as `broadcastToUser`/`fanOutToChannel`) — calling it
 * after the response has already been returned risks the `waitUntil`
 * registration being dropped.
 */
export function enqueueBotWakes(opts: EnqueueBotWakesOpts): Promise<void> {
  const { env, ctx } = getCloudflareContext()
  const promise = doEnqueueBotWakes(env as Env, opts)
  try {
    ctx.waitUntil(promise.catch((err) => {
      log.warn("enqueue_bot_wakes_failed", { err: String(err) })
    }))
  } catch {
    // Not in a CF request context (e.g. some test harnesses) — the promise
    // still runs to completion on its own.
  }
  return promise
}

/**
 * `NODE_ENV === "development"` (never `test`, `production`, or an
 * opennextjs-cloudflare preview/deploy build — all of which set `NODE_ENV`
 * to something else) is the only case that gets the dev HTTP transport;
 * every other environment keeps the real Cloudflare Queue.
 */
function selectWakeTransport(env: Env): WakeTransport {
  return process.env.NODE_ENV === "development"
    ? createDevHttpWakeTransport(env)
    : createQueueWakeTransport(env.WAKE_QUEUE)
}

async function doEnqueueBotWakes(env: Env, opts: EnqueueBotWakesOpts): Promise<void> {
  const { recipients, channelId, dmConversationId, messageRow } = opts
  if (recipients.length === 0) return

  const db = getDb(env.DB)
  const candidates = await queries.communityBot.findWakeCandidates(db, {
    recipients,
    channelId,
    dmConversationId,
    newSeq: messageRow.seq,
  })
  if (candidates.length === 0) return

  const payloads: WakePayload[] = candidates.map((c) => ({
    messageId: messageRow.id,
    botUserId: c.botUserId,
  }))

  const chunks: WakePayload[][] = []
  for (let i = 0; i < payloads.length; i += WAKE_BATCH_SIZE) {
    chunks.push(payloads.slice(i, i + WAKE_BATCH_SIZE))
  }

  const transport = selectWakeTransport(env)
  const results = await Promise.allSettled(chunks.map((chunk) => transport.send(chunk)))
  for (let i = 0; i < results.length; i++) {
    const r = results[i]!
    if (r.status === "rejected") {
      log.warn("wake_batch_chunk_failed", {
        botIds: chunks[i]!.map((p) => p.botUserId),
        err: String(r.reason),
      })
    }
  }
}
