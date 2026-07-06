import { getCloudflareContext } from "@opennextjs/cloudflare"
import type { WsMessage, DaemonPushMessage } from "@alook/shared"
import { DEV_WS_DO_URL, createLogger } from "@alook/shared"

const log = createLogger({ service: "broadcast" })

/**
 * Fetch against the WS DO worker.
 *
 * Prefers the `WS_DO_WORKER` service binding (production). If the binding
 * isn't available (local dev, unit tests) OR the binding responds with a
 * non-OK status (5xx), falls through to an HTTP fetch against
 * `env.DEV_WS_DO_URL` (or the shared default in `@alook/shared`).
 *
 * Owns the "try binding → non-OK/throw → HTTP fallback" pattern in one
 * place so callers don't reinvent it (and don't drift on the fallback URL).
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
  // Try service binding first.
  const binding = env.WS_DO_WORKER
  let bindingAttempted = false
  if (binding) {
    bindingAttempted = true
    try {
      const res = await binding.fetch(`http://internal${path}`, init)
      if (res.ok) return res
      // 4xx = client error — don't retry; fallback will return the same status.
      if (res.status >= 400 && res.status < 500) {
        log.warn("broadcast service-binding non-ok (client-error)", {
          label: opts?.label,
          type: opts?.type,
          path,
          status: res.status,
        })
        return res
      }
      // 5xx — fall through to HTTP fallback so the message isn't silently dropped.
      log.warn("broadcast service-binding non-ok", {
        label: opts?.label,
        type: opts?.type,
        path,
        status: res.status,
      })
    } catch (err) {
      log.warn("broadcast service-binding threw, falling back", {
        label: opts?.label,
        type: opts?.type,
        path,
        err: String(err),
      })
    }
  }

  // HTTP fallback.
  const base = env.DEV_WS_DO_URL || DEV_WS_DO_URL
  try {
    const res = await fetch(`${base}${path}`, init)
    if (!res.ok) {
      log.error("broadcast HTTP fallback non-ok", {
        label: opts?.label,
        type: opts?.type,
        path,
        status: res.status,
        url: base,
      })
    } else if (bindingAttempted) {
      // Only meaningful when the fallback rescued a failed binding call.
      log.info("broadcast HTTP fallback recovered", {
        label: opts?.label,
        type: opts?.type,
        path,
      })
    }
    return res
  } catch (err) {
    log.error("broadcast HTTP fallback threw", {
      label: opts?.label,
      type: opts?.type,
      path,
      url: base,
      err: String(err),
    })
    throw err
  }
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
    ctx.waitUntil(promise.catch(() => {}))
  } catch {
    // Not in CF context — promise runs on its own
  }
  return promise.then(() => {})
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
    ctx.waitUntil(promise.catch(() => {}))
  } catch {
    // Not in CF context — promise runs on its own
  }
  return promise
}
