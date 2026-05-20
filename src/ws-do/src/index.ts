import { createLogger } from "@alook/shared"

export { WebSocketDurableObject } from "./ws-durable"

const log = createLogger({ service: "ws-do" })

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const traceId = request.headers.get("X-Trace-Id") ?? undefined

    const daemonBroadcast = url.pathname.match(/^\/broadcast\/daemon\/(.+)$/)
    if (daemonBroadcast && request.method === "POST") {
      const daemonId = daemonBroadcast[1]
      const reqLog = log.child({ traceId, daemonId })
      reqLog.debug("broadcasting to daemon")

      const doId = env.WS_DO.idFromName("daemon:" + daemonId)
      const stub = env.WS_DO.get(doId)
      return stub.fetch(new Request("http://internal/broadcast", { method: "POST", body: request.body, duplex: "half" } as RequestInit))
    }

    const userBroadcast = url.pathname.match(/^\/broadcast\/user\/(.+)$/)
    if (userBroadcast && request.method === "POST") {
      const userId = userBroadcast[1]
      const reqLog = log.child({ traceId, userId })
      reqLog.debug("broadcasting to user")

      const doId = env.WS_DO.idFromName("user:" + userId)
      const stub = env.WS_DO.get(doId)
      return stub.fetch(new Request("http://internal/broadcast", { method: "POST", body: request.body, duplex: "half" } as RequestInit))
    }

    const daemonId = url.searchParams.get("daemonId")
    if (daemonId) {
      const reqLog = log.child({ traceId, daemonId })
      reqLog.info("daemon websocket upgrade")

      const doId = env.WS_DO.idFromName("daemon:" + daemonId)
      const stub = env.WS_DO.get(doId)
      return stub.fetch(request)
    }

    const userId = url.searchParams.get("userId")
    if (!userId) return new Response("userId required", { status: 400 })

    const reqLog = log.child({ traceId, userId })
    reqLog.info("websocket upgrade")

    const doId = env.WS_DO.idFromName("user:" + userId)
    const stub = env.WS_DO.get(doId)
    return stub.fetch(request)
  },
}
