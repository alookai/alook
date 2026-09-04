import { parseAttemptedCountReceipt, queries, withD1Retry } from "@alook/shared"
import type { RouterContext } from "../router-context"

export async function handleMachinePush({ request, env, url, traceId, log }: RouterContext): Promise<Response | null> {
  // POST /community-machine/by-id/<machineId>/push — push a HostCommand to
  // the daemon connection for this machine. Bot state frames are best-effort;
  // callers of direct agent events inspect the returned real socket count.
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
      if (!res.ok) continue
      const receipt = await res.json() as { sent?: unknown }
      if (
        typeof receipt.sent === "number"
        && Number.isSafeInteger(receipt.sent)
        && receipt.sent >= 0
      ) delivered += receipt.sent
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
  // then aggregates each DO's rolling `{ attempted: N, sent: N }` receipt.
  // A successful socket write is only an attempt; daemon `agent_wake_ack`
  // is the receipt and unread D1 state remains the reconnect truth.
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
    return Response.json({ attempted: 0, sent: 0 })
  }
  const bodyText = await request.text()
  let attempted = 0
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
      attempted += parseAttemptedCountReceipt(await res.json())
    } catch {
      transientFailure = true
    }
  }
  if (transientFailure) {
    return Response.json({ error: "failed to forward agent wake" }, { status: 503 })
  }
  return Response.json({ attempted, sent: attempted })
}
