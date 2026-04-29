import { getCloudflareContext } from "@opennextjs/cloudflare"
import type { WsMessage } from "@alook/shared"
import { DEV_WS_DO_URL, createLogger } from "@alook/shared"

const log = createLogger({ service: "broadcast" })

async function sendBroadcast(url: string, body: string, label: Record<string, string>) {
  try {
    const { env, ctx } = getCloudflareContext()
    const wsEnv = env as Env
    const promise = wsEnv.WS_DO_WORKER.fetch(`http://internal${url}`, {
      method: "POST",
      body,
    }).then(
      () => {},
      (err) => log.warn("broadcast service-binding failed", { ...label, err: String(err) }),
    )
    ctx.waitUntil(promise)
  } catch {
    const res = await fetch(`${DEV_WS_DO_URL}${url}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    })
    if (!res.ok) {
      log.warn("broadcast fallback failed", { ...label, status: res.status })
    }
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
