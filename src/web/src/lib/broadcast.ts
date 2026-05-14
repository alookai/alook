import { getCloudflareContext } from "@opennextjs/cloudflare"
import type { WsMessage } from "@alook/shared"
import { DEV_WS_DO_URL, createLogger } from "@alook/shared"

const log = createLogger({ service: "broadcast" })

async function sendBroadcast(url: string, body: string, label: Record<string, string>) {
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
  } catch {
    // Service binding unavailable (not in CF context, or local mode) — fall through
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

export async function broadcastToUser(userId: string, message: WsMessage) {
  await sendBroadcast(
    `/broadcast/user/${userId}`,
    JSON.stringify(message),
    { userId, type: message.type },
  )
}

export async function broadcastToAgent(agentId: string, message: WsMessage) {
  await sendBroadcast(
    `/broadcast/${agentId}`,
    JSON.stringify(message),
    { agentId, type: message.type },
  )
}
