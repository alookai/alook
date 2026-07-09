import { getCloudflareContext } from "@opennextjs/cloudflare"
import type { WsMessage, DaemonPushMessage } from "@alook/shared"
import { DEV_WS_DO_URL, createLogger } from "@alook/shared"
import { fetchViaBindingOrDevFallback } from "./dev-binding-fetch"

const log = createLogger({ service: "broadcast" })

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

export function broadcastToUser(userId: string, message: WsMessage): Promise<void> {
  return sendBroadcast(
    `/broadcast/user/${userId}`,
    JSON.stringify(message),
    { label: userId, type: message.type },
  )
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
