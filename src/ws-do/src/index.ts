import { createLogger } from "@alook/shared"

export { WebSocketDurableObject } from "./ws-durable"

const log = createLogger({ service: "ws-do" })

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === "/health" && request.method === "GET") {
      return Response.json({ status: "ok" })
    }

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

    const presenceCheck = url.pathname.match(/^\/presence\/user\/(.+)$/)
    if (presenceCheck && request.method === "GET") {
      const uid = presenceCheck[1]
      const doId = env.WS_DO.idFromName("user:" + uid)
      const stub = env.WS_DO.get(doId)
      return stub.fetch(new Request("http://internal/check-user-online"))
    }

    // POST /community-machine/<tokenId>/force-close — disconnect a daemon.
    const forceClose = url.pathname.match(/^\/community-machine\/([^/]+)\/force-close$/)
    if (forceClose && request.method === "POST") {
      const tokenId = decodeURIComponent(forceClose[1])
      const reqLog = log.child({ traceId, tokenId })
      reqLog.debug("force-closing community machine")

      const doId = env.WS_DO.idFromName("community-machine:" + tokenId)
      const stub = env.WS_DO.get(doId)
      return stub.fetch(new Request("http://internal/force-close", { method: "POST" }))
    }

    // Community-machine daemon WS upgrade — routed by ?token=<cmt_…>
    const machineToken = url.searchParams.get("token")
    if (machineToken) {
      if (!machineToken.startsWith("cmt_")) {
        // Defense in depth: only community tokens are accepted on this path.
        return new Response("invalid token", { status: 400 })
      }
      const reqLog = log.child({ traceId })
      reqLog.info("community machine websocket upgrade")
      const doId = env.WS_DO.idFromName("community-machine:" + machineToken)
      const stub = env.WS_DO.get(doId)
      return stub.fetch(request)
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
