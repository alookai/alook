import { createDb, createLogger, queries } from "@alook/shared"

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

    // Bulk presence: fan out one DO fetch per id and return the online subset.
    // Consolidates web-worker subrequest budget to a single call regardless of
    // membership size.
    if (url.pathname === "/presence/users" && request.method === "POST") {
      let body: unknown
      try {
        body = await request.json()
      } catch {
        return new Response("invalid json", { status: 400 })
      }
      const ids = (body as { ids?: unknown })?.ids
      if (!Array.isArray(ids)) return new Response("ids must be an array", { status: 400 })
      if (ids.length > 1000) return new Response("too many ids", { status: 400 })
      if (!ids.every((id): id is string => typeof id === "string")) {
        return new Response("ids must be strings", { status: 400 })
      }

      const reqLog = log.child({ traceId, count: ids.length })
      reqLog.debug("bulk presence check")

      if (ids.length === 0) return Response.json({ online: [] })

      const results = await Promise.allSettled(
        ids.map((id) => {
          const doId = env.WS_DO.idFromName("user:" + id)
          const stub = env.WS_DO.get(doId)
          return stub.fetch(new Request("http://internal/check-user-online"))
        })
      )
      const online: string[] = []
      for (let i = 0; i < results.length; i++) {
        const r = results[i]
        if (r.status !== "fulfilled" || !r.value.ok) continue
        try {
          const data = await r.value.json() as { online?: boolean }
          if (data.online) online.push(ids[i])
        } catch { /* skip */ }
      }
      return Response.json({ online })
    }

    // Per-user presence — dead in-tree, kept for rollout safety.
    const presenceCheck = url.pathname.match(/^\/presence\/user\/(.+)$/)
    if (presenceCheck && request.method === "GET") {
      const uid = presenceCheck[1]
      const doId = env.WS_DO.idFromName("user:" + uid)
      const stub = env.WS_DO.get(doId)
      return stub.fetch(new Request("http://internal/check-user-online"))
    }

    // POST /community-machine/<machineId>/force-close — disconnect a daemon
    // by its machine id (cm_<nanoid>). Keyed by machineId post-refactor.
    const forceClose = url.pathname.match(/^\/community-machine\/([^/]+)\/force-close$/)
    if (forceClose && request.method === "POST") {
      const machineId = decodeURIComponent(forceClose[1])
      const reqLog = log.child({ traceId, machineId })
      reqLog.debug("force-closing community machine")

      const doId = env.WS_DO.idFromName("community-machine:" + machineId)
      const stub = env.WS_DO.get(doId)
      return stub.fetch(new Request("http://internal/force-close", { method: "POST" }))
    }

    // Community-machine daemon WS upgrade — Bearer cmk_<credential> only.
    // The router looks up the credential to name the DO (by machineId);
    // the DO re-validates the same credential authoritatively.
    const authHeader = request.headers.get("Authorization")
    const legacyToken = url.searchParams.get("token")
    if (authHeader?.startsWith("Bearer cmk_")) {
      const credentialId = authHeader.slice(7).trim()
      const db = createDb(env.DB)
      const active = await queries.communityMachine.findActiveCredentialByBearer(db, credentialId)
      if (!active) {
        log.info("community machine ws rejected: unknown/revoked credential", { traceId })
        return new Response("credential revoked or unknown", { status: 401 })
      }
      const reqLog = log.child({ traceId, machineId: active.machineId })
      reqLog.info("community machine websocket upgrade")
      const doId = env.WS_DO.idFromName("community-machine:" + active.machineId)
      const stub = env.WS_DO.get(doId)
      return stub.fetch(request)
    }

    // Legacy daemon compat: reject `?token=cmt_...` with a helpful reason so
    // out-of-date daemons log a comprehensible message. Deleted a release
    // after users have upgraded.
    if (legacyToken) {
      log.info("legacy community machine ws token rejected — upgrade CLI", { traceId })
      return new Response(
        JSON.stringify({
          error: "daemon version out of date; please upgrade the alook CLI",
        }),
        { status: 426, headers: { "Content-Type": "application/json" } }
      )
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
