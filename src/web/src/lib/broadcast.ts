import { getCloudflareContext } from "@opennextjs/cloudflare"
import type { WsMessage } from "@alook/shared"
import { DEV_WS_DO_URL, createLogger } from "@alook/shared"

const log = createLogger({ service: "broadcast" })

async function doSend(url: string, body: string, label: Record<string, string>) {
  let wsDoUrl: string | undefined
  try {
    const { env } = getCloudflareContext()
    const wsEnv = env as Env
    wsDoUrl = (wsEnv as unknown as Record<string, unknown>).DEV_WS_DO_URL as string | undefined

    const res = await wsEnv.WS_DO_WORKER.fetch(`http://internal${url}`, {
      method: "POST",
      body,
    })
    if (res.ok) return
    log.warn("broadcast service-binding non-ok", { ...label, status: res.status })
    return
  } catch {
    // Service binding unavailable — fall through to HTTP
  }

  const fallbackUrl = wsDoUrl || DEV_WS_DO_URL
  try {
    const res = await fetch(`${fallbackUrl}${url}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    })
    if (!res.ok) {
      log.warn("broadcast failed", { ...label, status: res.status })
    }
  } catch (err) {
    log.warn("broadcast error", { ...label, err: String(err) })
  }
}

function sendBroadcast(url: string, body: string, label: Record<string, string>): Promise<void> {
  const promise = doSend(url, body, label)
  try {
    const { ctx } = getCloudflareContext()
    ctx.waitUntil(promise)
  } catch {
    // Not in CF context — promise runs on its own
  }
  return promise
}

export function broadcastToUser(userId: string, message: WsMessage): Promise<void> {
  return sendBroadcast(
    `/broadcast/user/${userId}`,
    JSON.stringify(message),
    { userId, type: message.type },
  )
}

export function broadcastToAgent(agentId: string, message: WsMessage): Promise<void> {
  return sendBroadcast(
    `/broadcast/${agentId}`,
    JSON.stringify(message),
    { agentId, type: message.type },
  )
}
