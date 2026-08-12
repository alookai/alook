import { queries, withD1Retry } from "@alook/shared"
import type { RouterContext } from "../router-context"

export async function handleMachinePush({ request, env, url, traceId, log }: RouterContext): Promise<Response | null> {
  // POST /community-machine/by-id/<machineId>/push — push a bot event
  // (bot:added / bot:updated / bot:removed) to the daemon connection for
  // this machine. Looks up the live credential do_name via D1 and dispatches
  // to the corresponding DO. Best-effort — if the daemon is offline the DO
  // drops the event; cold-start warmup on reconnect re-syncs authoritative
  // state.
  const pushToMachine = url.pathname.match(/^\/community-machine\/by-id\/([^/]+)\/push$/)
  if (!pushToMachine || request.method !== "POST") return null

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

export async function handleMachineWake({ request, env, url, traceId, log }: RouterContext): Promise<Response | null> {
  // POST /community-machine/by-id/<machineId>/forward-agent-wake — sibling
  // of the `/push` route above, for the minimal-wake-queue-unread-notice
  // wake path. Forwards an already-built `HostCommand` (`agent:wake`)
  // verbatim to every live DO for this machine's active credential(s),
  // then aggregates by parsing each DO's own `{ sent: N }` response —
  // unlike `/push`, we must NOT just count `res.ok`: a 200 with
  // `{ sent: 0 }` means that DO has no authenticated daemon socket at all,
  // which must not be reported as delivered.
  const forwardAgentWake = url.pathname.match(/^\/community-machine\/by-id\/([^/]+)\/forward-agent-wake$/)
  if (!forwardAgentWake || request.method !== "POST") return null

  const machineId = decodeURIComponent(forwardAgentWake[1])
  const reqLog = log.child({ traceId, machineId })
  reqLog.debug("forwarding agent:wake to machine")

  let doNames: string[] = []
  try {
    const shared = await import("@alook/shared")
    const db = shared.createDb((env as unknown as { DB: D1Database }).DB)
    doNames = await withD1Retry(
      () => queries.communityMachine.getActiveDoNamesForMachine(db, machineId),
      { route: "ws-do:agent-wake-machine-resolution" },
    )
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
