import type { RouterContext } from "../router-context"

export async function handleDaemonBroadcast({ request, env, url, traceId, log }: RouterContext): Promise<Response | null> {
  const daemonBroadcast = url.pathname.match(/^\/broadcast\/daemon\/(.+)$/)
  if (!daemonBroadcast || request.method !== "POST") return null

  const daemonId = daemonBroadcast[1]
  const reqLog = log.child({ traceId, daemonId })
  reqLog.debug("broadcasting to daemon")

  const doId = env.WS_DO.idFromName("daemon:" + daemonId)
  const stub = env.WS_DO.get(doId)
  return stub.fetch(new Request("http://internal/broadcast", { method: "POST", body: request.body, duplex: "half" } as RequestInit))
}

export async function handleUserBroadcast({ request, env, url, traceId, log }: RouterContext): Promise<Response | null> {
  const userBroadcast = url.pathname.match(/^\/broadcast\/user\/(.+)$/)
  if (!userBroadcast || request.method !== "POST") return null

  const userId = userBroadcast[1]
  const reqLog = log.child({ traceId, userId })
  reqLog.debug("broadcasting to user")

  const doId = env.WS_DO.idFromName("user:" + userId)
  const stub = env.WS_DO.get(doId)
  return stub.fetch(new Request("http://internal/broadcast", { method: "POST", body: request.body, duplex: "half" } as RequestInit))
}
