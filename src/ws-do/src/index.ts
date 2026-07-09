import { createLogger, queries } from "@alook/shared"

export { WebSocketDurableObject } from "./ws-durable"
export { RateLimitDurableObject } from "./rate-limit-do"

const log = createLogger({ service: "ws-do" })

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === "/health" && request.method === "GET") {
      return Response.json({ status: "ok" })
    }

    // Strongly-consistent, parameterized rate limiter. Every rate-limit
    // call site (community message send, auth OTP, future policies) hits
    // this single endpoint with a `{ name, key, windowMs, max }` payload
    // — one DO instance per (name, key) pair. Policy values come from the
    // shared `RATE_LIMITS` registry in `src/shared/src/lib/rate-limits.ts`
    // so ceilings live in one place, not scattered across route handlers.
    //
    // See `rate-limit-do.ts` for the counter logic.
    if (url.pathname === "/rate-limit/check" && request.method === "POST") {
      let body: unknown
      try {
        body = await request.json()
      } catch {
        return new Response("invalid json", { status: 400 })
      }
      const { name, key, windowMs, max } = (body ?? {}) as {
        name?: unknown
        key?: unknown
        windowMs?: unknown
        max?: unknown
      }
      if (typeof name !== "string" || name.length === 0) {
        return new Response("name required", { status: 400 })
      }
      if (typeof key !== "string" || key.length === 0) {
        return new Response("key required", { status: 400 })
      }
      const doId = env.RATE_LIMIT_DO.idFromName(name + ":" + key)
      const stub = env.RATE_LIMIT_DO.get(doId)
      return stub.fetch(
        new Request("http://internal/check", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ windowMs, max }),
        }),
      )
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
          return stub.fetch(
            new Request(`http://internal/check-user-online?userId=${encodeURIComponent(id)}`)
          )
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
      return stub.fetch(
        new Request(`http://internal/check-user-online?userId=${encodeURIComponent(uid)}`)
      )
    }

    // POST /community-machine/by-id/<machineId>/push — push a bot event
    // (bot:added / bot:updated / bot:removed) to the daemon connection for
    // this machine. Looks up the live credential do_name via D1 and dispatches
    // to the corresponding DO. Best-effort — if the daemon is offline the DO
    // drops the event; cold-start warmup on reconnect re-syncs authoritative
    // state.
    const pushToMachine = url.pathname.match(/^\/community-machine\/by-id\/([^/]+)\/push$/)
    if (pushToMachine && request.method === "POST") {
      const machineId = decodeURIComponent(pushToMachine[1])
      const reqLog = log.child({ traceId, machineId })
      reqLog.debug("pushing bot event to machine")
      // Look up the active `do_name` for this machineId via D1. Multiple
      // credentials may exist for a machine over time; we push to every live
      // one (there should be exactly one, but be robust).
      let doNames: string[] = []
      try {
        const shared = await import("@alook/shared")
        const db = shared.createDb((env as unknown as { DB: D1Database }).DB)
        doNames = await queries.communityMachine.getActiveDoNamesForMachine(db, machineId)
      } catch {
        // If we can't reach D1 to resolve, silently drop — the daemon's
        // reconnect warmup will re-sync authoritative state.
        return Response.json({ sent: 0 })
      }
      if (doNames.length === 0) {
        return Response.json({ sent: 0 })
      }
      const bodyText = await request.text()
      let delivered = 0
      for (const dn of doNames) {
        const doId = env.WS_DO.idFromName("community-machine:" + dn)
        const stub = env.WS_DO.get(doId)
        try {
          const res = await stub.fetch(
            new Request("http://internal/push", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: bodyText,
            }),
          )
          if (res.ok) delivered++
        } catch {
          // best-effort
        }
      }
      return Response.json({ sent: delivered })
    }

    // POST /community-machine/by-id/<machineId>/forward-agent-wake — sibling
    // of the `/push` route above, for the minimal-wake-queue-unread-notice
    // wake path. Forwards an already-built `HostCommand` (`agent:wake`)
    // verbatim to every live DO for this machine's active credential(s),
    // then aggregates by parsing each DO's own `{ sent: N }` response —
    // unlike `/push`, we must NOT just count `res.ok`: a 200 with
    // `{ sent: 0 }` means that DO has no authenticated daemon socket at all,
    // which must not be reported as delivered.
    const forwardAgentWake = url.pathname.match(/^\/community-machine\/by-id\/([^/]+)\/forward-agent-wake$/)
    if (forwardAgentWake && request.method === "POST") {
      const machineId = decodeURIComponent(forwardAgentWake[1])
      const reqLog = log.child({ traceId, machineId })
      reqLog.debug("forwarding agent:wake to machine")

      let doNames: string[] = []
      try {
        const shared = await import("@alook/shared")
        const db = shared.createDb((env as unknown as { DB: D1Database }).DB)
        doNames = await queries.communityMachine.getActiveDoNamesForMachine(db, machineId)
      } catch (err) {
        reqLog.error("failed to resolve machine doNames for agent wake", { err })
        return Response.json({ error: "failed to resolve machine" }, { status: 503 })
      }
      if (doNames.length === 0) {
        return Response.json({ sent: 0 })
      }
      const bodyText = await request.text()
      let delivered = 0
      let transientFailure = false
      for (const dn of doNames) {
        const doId = env.WS_DO.idFromName("community-machine:" + dn)
        const stub = env.WS_DO.get(doId)
        try {
          const res = await stub.fetch(
            new Request("http://internal/forward-agent-wake", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: bodyText,
            }),
          )
          if (!res.ok) {
            transientFailure = true
            continue
          }
          const data = (await res.json()) as { sent?: unknown }
          if (typeof data.sent !== "number" || !Number.isFinite(data.sent) || data.sent < 0) {
            transientFailure = true
            continue
          }
          delivered += data.sent
        } catch {
          transientFailure = true
        }
      }
      if (delivered === 0 && transientFailure) {
        return Response.json({ error: "failed to forward agent wake" }, { status: 503 })
      }
      return Response.json({ sent: delivered })
    }

    // POST /community-machine/<doName>/force-close — disconnect a daemon by
    // its DO-name suffix (first 32 hex of the credential hash). Callers look
    // the suffix up from `community_machine_credential.do_name`.
    const forceClose = url.pathname.match(/^\/community-machine\/([^/]+)\/force-close$/)
    if (forceClose && request.method === "POST") {
      const doName = decodeURIComponent(forceClose[1])
      const reqLog = log.child({ traceId, doName })
      reqLog.debug("force-closing community machine")

      const doId = env.WS_DO.idFromName("community-machine:" + doName)
      const stub = env.WS_DO.get(doId)
      return stub.fetch(new Request("http://internal/force-close", { method: "POST" }))
    }

    // Community-machine daemon WS upgrade — Bearer cmk_<credential> only.
    // Router names the DO from `sha256(bearer).slice(0,32)` without hitting
    // D1; the DO re-validates the full hash authoritatively on first accept.
    const authHeader = request.headers.get("Authorization")
    if (authHeader?.startsWith("Bearer cmk_")) {
      const bearer = authHeader.slice(7).trim()
      const hash = await queries.communityMachine.hashCredential(bearer)
      const doName = queries.communityMachine.doNameFromHash(hash)
      const reqLog = log.child({ traceId })
      reqLog.info("community machine websocket upgrade")
      const doId = env.WS_DO.idFromName("community-machine:" + doName)
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
