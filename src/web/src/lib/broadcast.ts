import { getCloudflareContext } from "@opennextjs/cloudflare"
import type { WsMessage, DaemonPushMessage } from "@alook/shared"
import { DEV_WS_DO_URL, createLogger } from "@alook/shared"
import { fetchViaBindingOrDevFallback } from "./dev-binding-fetch"

const log = createLogger({ service: "broadcast" })
const bulkBroadcastMaxUserIds = 1000
const bulkBroadcastMaxActive = 3

/**
 * Fetch against the WS DO worker.
 *
 * Prefers the `WS_DO_WORKER` service binding (production). If the binding
 * isn't available (local dev, unit tests) OR the binding responds with a
 * non-OK status (5xx), falls through to an HTTP fetch against
 * `env.DEV_WS_DO_URL` (or the shared default in `@alook/shared`).
 *
 * Thin wrapper around `fetchViaBindingOrDevFallback` — see that module for
 * the actual "try binding → non-OK/throw → HTTP fallback" decision tree so
 * callers (this + `wake-transport.ts`) don't reinvent it.
 *
 * Pass `opts.label` / `opts.type` to enrich the on-call diagnostic emitted
 * when the binding returns non-OK — e.g. `{ label: userId, type: message.type }`.
 */
export async function wsDoFetch(
  env: Env,
  path: string,
  init: RequestInit,
  opts?: { label?: string; type?: string },
): Promise<Response> {
  return fetchViaBindingOrDevFallback(env.WS_DO_WORKER, env.DEV_WS_DO_URL || DEV_WS_DO_URL, path, init, {
    logPrefix: "broadcast",
    log,
    label: opts?.label,
    type: opts?.type,
  })
}

async function doSend(
  url: string,
  body: string,
  opts: { label: string; type: string },
): Promise<{ sent: number }> {
  const { env } = getCloudflareContext()
  const res = await wsDoFetch(env as Env, url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  }, opts)
  if (!res.ok) {
    throw new Error(`broadcast failed: ${res.status}`)
  }
  try {
    const json = await res.json() as { sent?: number }
    return { sent: json.sent ?? 0 }
  } catch {
    return { sent: 0 }
  }
}

function sendBroadcast(url: string, body: string, opts: { label: string; type: string }): Promise<void> {
  const promise = doSend(url, body, opts)
  try {
    const { ctx } = getCloudflareContext()
    ctx.waitUntil(promise.catch(() => { }))
  } catch {
    // Not in CF context — promise runs on its own
  }
  return promise.then(() => { })
}

type BroadcastChunkResult = { sent: number }

async function settleBroadcastChunks(
  chunks: readonly string[][],
  run: (chunk: string[], index: number) => Promise<BroadcastChunkResult>,
): Promise<{
  results: PromiseSettledResult<BroadcastChunkResult>[]
  maxActive: number
}> {
  const results = new Array<PromiseSettledResult<BroadcastChunkResult>>(chunks.length)
  let nextIndex = 0
  let active = 0
  let maxActive = 0

  const workers = Array.from(
    { length: Math.min(bulkBroadcastMaxActive, chunks.length) },
    async () => {
      while (nextIndex < chunks.length) {
        const index = nextIndex
        nextIndex += 1
        active += 1
        maxActive = Math.max(maxActive, active)
        try {
          results[index] = { status: "fulfilled", value: await run(chunks[index], index) }
        } catch (reason) {
          results[index] = { status: "rejected", reason }
        } finally {
          active -= 1
        }
      }
    },
  )

  await Promise.all(workers)
  return { results, maxActive }
}

function safeLog(write: () => void): void {
  try {
    write()
  } catch {}
}

async function runBroadcastToUsers(
  userIds: string[],
  message: WsMessage,
  excludeUserId?: string,
): Promise<void> {
  const startedAt = Date.now()
  const uniqueUserIds = [...new Set(userIds)]
  const targetUserIds = excludeUserId === undefined
    ? uniqueUserIds
    : uniqueUserIds.filter((userId) => userId !== excludeUserId)
  const chunks: string[][] = []

  for (let start = 0; start < targetUserIds.length; start += bulkBroadcastMaxUserIds) {
    chunks.push(targetUserIds.slice(start, start + bulkBroadcastMaxUserIds))
  }

  const target = `users:${targetUserIds.length}`
  const { results, maxActive } = await settleBroadcastChunks(
    chunks,
    async (chunk, index) => {
      const chunkStartedAt = Date.now()
      const chunkNumber = index + 1
      try {
        const result = await doSend(
          "/broadcast/users",
          JSON.stringify({ userIds: chunk, message, ...(excludeUserId === undefined ? {} : { excludeUserId }) }),
          { label: `${target}:chunk:${chunkNumber}/${chunks.length}`, type: message.type },
        )
        safeLog(() => log.info("broadcast_users_chunk_complete", {
          target,
          type: message.type,
          chunkNumber,
          chunkCount: chunks.length,
          chunkSize: chunk.length,
          transportStatus: "success",
          sent: result.sent,
          durationMs: Date.now() - chunkStartedAt,
        }))
        return result
      } catch (reason) {
        safeLog(() => log.warn("broadcast_users_chunk_complete", {
          target,
          type: message.type,
          chunkNumber,
          chunkCount: chunks.length,
          chunkSize: chunk.length,
          transportStatus: "failure",
          durationMs: Date.now() - chunkStartedAt,
        }))
        throw reason
      }
    },
  )

  let transportSuccessChunkCount = 0
  let transportFailureChunkCount = 0
  let sent = 0
  for (const result of results) {
    if (result.status === "fulfilled") {
      transportSuccessChunkCount += 1
      sent += result.value.sent
    } else {
      transportFailureChunkCount += 1
    }
  }

  safeLog(() => log.info("broadcast_users_complete", {
    target,
    type: message.type,
    inputCount: userIds.length,
    uniqueCount: uniqueUserIds.length,
    excludedCount: uniqueUserIds.length - targetUserIds.length,
    targetCount: targetUserIds.length,
    chunkCount: chunks.length,
    transportSuccessChunkCount,
    transportFailureChunkCount,
    sent,
    maxActive,
    durationMs: Date.now() - startedAt,
  }))

  if (transportFailureChunkCount > 0) {
    throw new Error(`broadcast failed for ${transportFailureChunkCount} of ${chunks.length} chunks`)
  }
}

export function broadcastToUser(userId: string, message: WsMessage): Promise<void> {
  return sendBroadcast(
    `/broadcast/user/${userId}`,
    JSON.stringify(message),
    { label: userId, type: message.type },
  )
}

export function broadcastToUsers(
  userIds: string[],
  message: WsMessage,
  excludeUserId?: string,
): Promise<void> {
  const work = runBroadcastToUsers(userIds, message, excludeUserId)
  try {
    const { ctx } = getCloudflareContext()
    ctx.waitUntil(work.catch(() => {}))
  } catch {}
  return work
}


export function broadcastToDaemon(daemonId: string, message: DaemonPushMessage): Promise<{ sent: number }> {
  const promise = doSend(
    `/broadcast/daemon/${daemonId}`,
    JSON.stringify(message),
    { label: daemonId, type: message.type },
  )
  try {
    // CF worker may terminate before the fetch completes if the response is sent early;
    // waitUntil keeps the isolate alive until the broadcast resolves.
    const { ctx } = getCloudflareContext()
    ctx.waitUntil(promise.catch(() => { }))
  } catch {
    // Not in CF context — promise runs on its own
  }
  return promise
}
