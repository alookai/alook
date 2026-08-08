import { queries } from "@alook/shared"
import type { RouterContext } from "../router-context"

export async function handleMachineReset({ request, env, url, traceId, log }: RouterContext): Promise<Response | null> {
  // POST /community-machine/by-id/<machineId>/forward-agent-reset — owner-
  // triggered `agent:reset` push. Same shape as `/forward-agent-wake`: build
  // the HostCommand from a narrow payload (`{ agentId, config, launchId }`),
  // resolve the machine's active `do_names`, forward the frame to each DO's
  // `/push` route, and aggregate `{ sent }`. Rejects any extra field —
  // callers must use `pushAgentResetToMachine`.
  const forwardAgentReset = url.pathname.match(/^\/community-machine\/by-id\/([^/]+)\/forward-agent-reset$/)
  if (!forwardAgentReset || request.method !== "POST") return null

  const machineId = decodeURIComponent(forwardAgentReset[1])
  const reqLog = log.child({ traceId, machineId })
  reqLog.debug("forwarding agent:reset to machine")

  let payload: unknown
  try {
    payload = await request.json()
  } catch {
    return Response.json({ error: "invalid payload" }, { status: 400 })
  }
  if (!payload || typeof payload !== "object") {
    return Response.json({ error: "invalid payload" }, { status: 400 })
  }
  const raw = payload as Record<string, unknown>
  const allowedKeys = new Set(["agentId", "config", "launchId"])
  for (const key of Object.keys(raw)) {
    if (!allowedKeys.has(key)) {
      return Response.json({ error: "invalid payload" }, { status: 400 })
    }
  }
  const { agentId, config, launchId } = raw
  if (typeof agentId !== "string" || agentId.length === 0) {
    return Response.json({ error: "invalid payload" }, { status: 400 })
  }
  if (typeof launchId !== "string" || launchId.length === 0) {
    return Response.json({ error: "invalid payload" }, { status: 400 })
  }
  if (!config || typeof config !== "object") {
    return Response.json({ error: "invalid payload" }, { status: 400 })
  }

  let doNames: string[] = []
  try {
    const shared = await import("@alook/shared")
    const db = shared.createDb((env as unknown as { DB: D1Database }).DB)
    doNames = await queries.communityMachine.getActiveDoNamesForMachine(db, machineId)
  } catch (err) {
    reqLog.error("failed to resolve machine doNames for agent reset", { err })
    return Response.json({ error: "failed to resolve machine" }, { status: 503 })
  }
  if (doNames.length === 0) {
    return Response.json({ sent: 0 })
  }
  const frame = JSON.stringify({ type: "agent:reset", agentId, config, launchId })
  let delivered = 0
  let transientFailure = false
  for (const dn of doNames) {
    const doId = env.WS_DO.idFromName("community-machine:" + dn)
    const stub = env.WS_DO.get(doId)
    try {
      const res = await stub.fetch(
        new Request("http://internal/push", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: frame,
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
    return Response.json({ error: "failed to forward agent reset" }, { status: 503 })
  }
  return Response.json({ sent: delivered })
}

export async function handleMachineBatchReset({ request, env, url, traceId, log }: RouterContext): Promise<Response | null> {
  // POST /community-machine/by-id/<machineId>/forward-batch-reset —
  // owner-triggered `machine:reset_all` push (batch reset all agents on the
  // machine in ONE frame, not N fanned-out agent:reset). Twin of
  // /forward-agent-reset: same doName resolution + `/push` fan-out + `{sent}`
  // aggregation, but the body is a `resets` array (each item the narrow
  // {agentId, config, launchId}) and the frame type is `machine:reset_all`.
  // Callers must use `pushBatchResetToMachine`.
  const forwardBatchReset = url.pathname.match(/^\/community-machine\/by-id\/([^/]+)\/forward-batch-reset$/)
  if (!forwardBatchReset || request.method !== "POST") return null

  const machineId = decodeURIComponent(forwardBatchReset[1])
  const reqLog = log.child({ traceId, machineId })
  reqLog.debug("forwarding machine:reset_all to machine")

  let payload: unknown
  try {
    payload = await request.json()
  } catch {
    return Response.json({ error: "invalid payload" }, { status: 400 })
  }
  if (!payload || typeof payload !== "object") {
    return Response.json({ error: "invalid payload" }, { status: 400 })
  }
  const raw = payload as Record<string, unknown>
  // Only `resets` allowed at the top level.
  for (const key of Object.keys(raw)) {
    if (key !== "resets") {
      return Response.json({ error: "invalid payload" }, { status: 400 })
    }
  }
  if (!Array.isArray(raw.resets)) {
    return Response.json({ error: "invalid payload" }, { status: 400 })
  }
  // Validate each reset entry against the same narrow allowlist as
  // forward-agent-reset — no extra fields, all three required.
  const resets: Array<{ agentId: string; config: unknown; launchId: string }> = []
  for (const item of raw.resets) {
    if (!item || typeof item !== "object") {
      return Response.json({ error: "invalid payload" }, { status: 400 })
    }
    const r = item as Record<string, unknown>
    const allowedKeys = new Set(["agentId", "config", "launchId"])
    for (const key of Object.keys(r)) {
      if (!allowedKeys.has(key)) {
        return Response.json({ error: "invalid payload" }, { status: 400 })
      }
    }
    if (typeof r.agentId !== "string" || r.agentId.length === 0) {
      return Response.json({ error: "invalid payload" }, { status: 400 })
    }
    if (typeof r.launchId !== "string" || r.launchId.length === 0) {
      return Response.json({ error: "invalid payload" }, { status: 400 })
    }
    if (!r.config || typeof r.config !== "object") {
      return Response.json({ error: "invalid payload" }, { status: 400 })
    }
    resets.push({ agentId: r.agentId, config: r.config, launchId: r.launchId })
  }

  let doNames: string[] = []
  try {
    const shared = await import("@alook/shared")
    const db = shared.createDb((env as unknown as { DB: D1Database }).DB)
    doNames = await queries.communityMachine.getActiveDoNamesForMachine(db, machineId)
  } catch (err) {
    reqLog.error("failed to resolve machine doNames for batch reset", { err })
    return Response.json({ error: "failed to resolve machine" }, { status: 503 })
  }
  if (doNames.length === 0) {
    return Response.json({ sent: 0 })
  }
  const frame = JSON.stringify({ type: "machine:reset_all", resets })
  let delivered = 0
  let transientFailure = false
  for (const dn of doNames) {
    const doId = env.WS_DO.idFromName("community-machine:" + dn)
    const stub = env.WS_DO.get(doId)
    try {
      const res = await stub.fetch(
        new Request("http://internal/push", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: frame,
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
    return Response.json({ error: "failed to forward batch reset" }, { status: 503 })
  }
  return Response.json({ sent: delivered })
}

export async function handleMachineNap({ request, env, url, traceId, log }: RouterContext): Promise<Response | null> {
  // POST /community-machine/by-id/<machineId>/forward-agent-nap — agent
  // self-initiated `agent:nap` push. Twin of /forward-agent-reset but the
  // allowlist additionally carries the mandatory `handoff` string (the
  // agent's note to its reborn self, spliced into the rewake prompt). Same
  // doName resolution + `/push` fan-out + `{sent}` aggregation. Callers must
  // use `pushAgentNapToMachine`.
  const forwardAgentNap = url.pathname.match(/^\/community-machine\/by-id\/([^/]+)\/forward-agent-nap$/)
  if (!forwardAgentNap || request.method !== "POST") return null

  const machineId = decodeURIComponent(forwardAgentNap[1])
  const reqLog = log.child({ traceId, machineId })
  reqLog.debug("forwarding agent:nap to machine")

  let payload: unknown
  try {
    payload = await request.json()
  } catch {
    return Response.json({ error: "invalid payload" }, { status: 400 })
  }
  if (!payload || typeof payload !== "object") {
    return Response.json({ error: "invalid payload" }, { status: 400 })
  }
  const raw = payload as Record<string, unknown>
  const allowedKeys = new Set(["agentId", "config", "launchId", "handoff"])
  for (const key of Object.keys(raw)) {
    if (!allowedKeys.has(key)) {
      return Response.json({ error: "invalid payload" }, { status: 400 })
    }
  }
  const { agentId, config, launchId, handoff } = raw
  if (typeof agentId !== "string" || agentId.length === 0) {
    return Response.json({ error: "invalid payload" }, { status: 400 })
  }
  if (typeof launchId !== "string" || launchId.length === 0) {
    return Response.json({ error: "invalid payload" }, { status: 400 })
  }
  if (!config || typeof config !== "object") {
    return Response.json({ error: "invalid payload" }, { status: 400 })
  }
  if (typeof handoff !== "string" || handoff.trim().length === 0) {
    return Response.json({ error: "invalid payload" }, { status: 400 })
  }

  let doNames: string[] = []
  try {
    const shared = await import("@alook/shared")
    const db = shared.createDb((env as unknown as { DB: D1Database }).DB)
    doNames = await queries.communityMachine.getActiveDoNamesForMachine(db, machineId)
  } catch (err) {
    reqLog.error("failed to resolve machine doNames for agent nap", { err })
    return Response.json({ error: "failed to resolve machine" }, { status: 503 })
  }
  if (doNames.length === 0) {
    return Response.json({ sent: 0 })
  }
  const frame = JSON.stringify({ type: "agent:nap", agentId, config, launchId, handoff })
  let delivered = 0
  let transientFailure = false
  for (const dn of doNames) {
    const doId = env.WS_DO.idFromName("community-machine:" + dn)
    const stub = env.WS_DO.get(doId)
    try {
      const res = await stub.fetch(
        new Request("http://internal/push", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: frame,
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
    return Response.json({ error: "failed to forward agent nap" }, { status: 503 })
  }
  return Response.json({ sent: delivered })
}

export async function handleMachineForceClose({ request, env, url, traceId, log }: RouterContext): Promise<Response | null> {
  // POST /community-machine/<doName>/force-close — disconnect a daemon by
  // its DO-name suffix (first 32 hex of the credential hash). Callers look
  // the suffix up from `community_machine_credential.do_name`.
  const forceClose = url.pathname.match(/^\/community-machine\/([^/]+)\/force-close$/)
  if (!forceClose || request.method !== "POST") return null

  const doName = decodeURIComponent(forceClose[1])
  const reqLog = log.child({ traceId, doName })
  reqLog.debug("force-closing community machine")

  const doId = env.WS_DO.idFromName("community-machine:" + doName)
  const stub = env.WS_DO.get(doId)
  return stub.fetch(new Request("http://internal/force-close", { method: "POST" }))
}
