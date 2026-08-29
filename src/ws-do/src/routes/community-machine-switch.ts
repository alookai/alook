import { queries } from "@alook/shared"
import type { RouterContext } from "../router-context"

export async function handleMachineModelSwitch({ request, env, url, traceId, log }: RouterContext): Promise<Response | null> {
  // POST /community-machine/by-id/<machineId>/forward-agent-model-switch —
  // owner-triggered model switch. `from`/`to` stay server-side for completion
  // attribution; the machine DO forwards only the daemon's existing
  // `agent:model_switch` frame.
  const forwardAgentModelSwitch = url.pathname.match(/^\/community-machine\/by-id\/([^/]+)\/forward-agent-model-switch$/)
  if (!forwardAgentModelSwitch || request.method !== "POST") return null

  const machineId = decodeURIComponent(forwardAgentModelSwitch[1])
  const reqLog = log.child({ traceId, machineId })
  reqLog.debug("forwarding agent:model_switch to machine")

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
  const allowedKeys = new Set(["agentId", "config", "launchId", "from", "to"])
  for (const key of Object.keys(raw)) {
    if (!allowedKeys.has(key)) {
      return Response.json({ error: "invalid payload" }, { status: 400 })
    }
  }
  const { agentId, config, launchId, from, to } = raw
  if (typeof agentId !== "string" || agentId.length === 0) {
    return Response.json({ error: "invalid payload" }, { status: 400 })
  }
  if (typeof launchId !== "string" || launchId.length === 0) {
    return Response.json({ error: "invalid payload" }, { status: 400 })
  }
  if (!config || typeof config !== "object") {
    return Response.json({ error: "invalid payload" }, { status: 400 })
  }
  if ((from !== null && typeof from !== "string") || (to !== null && typeof to !== "string")) {
    return Response.json({ error: "invalid payload" }, { status: 400 })
  }

  let doNames: string[] = []
  try {
    const shared = await import("@alook/shared")
    const db = shared.createDb((env as unknown as { DB: D1Database }).DB)
    doNames = await queries.communityMachine.getActiveDoNamesForMachine(db, machineId)
  } catch (err) {
    reqLog.error("failed to resolve machine doNames for agent model switch", { err })
    return Response.json({ error: "failed to resolve machine" }, { status: 503 })
  }
  if (doNames.length === 0) {
    return Response.json({ sent: 0 })
  }
  const frame = JSON.stringify({ agentId, config, launchId, from, to })
  let delivered = 0
  let transientFailure = false
  for (const dn of doNames) {
    const doId = env.WS_DO.idFromName("community-machine:" + dn)
    const stub = env.WS_DO.get(doId)
    try {
      const res = await stub.fetch(
        new Request("http://internal/push-model-switch", {
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
    return Response.json({ error: "failed to forward agent model switch" }, { status: 503 })
  }
  return Response.json({ sent: delivered })
}

export async function handleMachineProviderSwitch({ request, env, url, traceId, log }: RouterContext): Promise<Response | null> {
  const forwardAgentProviderSwitch = url.pathname.match(/^\/community-machine\/by-id\/([^/]+)\/forward-agent-provider-switch$/)
  if (!forwardAgentProviderSwitch || request.method !== "POST") return null

  const machineId = decodeURIComponent(forwardAgentProviderSwitch[1])
  const reqLog = log.child({ traceId, machineId })

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
  const allowedKeys = new Set(["agentId", "config", "launchId", "from", "to"])
  for (const key of Object.keys(raw)) {
    if (!allowedKeys.has(key)) return Response.json({ error: "invalid payload" }, { status: 400 })
  }
  const { agentId, config, launchId, from, to } = raw
  if (
    typeof agentId !== "string" || agentId.length === 0 ||
    typeof launchId !== "string" || launchId.length === 0 ||
    !config || typeof config !== "object" ||
    typeof from !== "string" || from.length === 0 ||
    typeof to !== "string" || to.length === 0
  ) {
    return Response.json({ error: "invalid payload" }, { status: 400 })
  }

  let doNames: string[] = []
  try {
    const shared = await import("@alook/shared")
    const db = shared.createDb((env as unknown as { DB: D1Database }).DB)
    doNames = await queries.communityMachine.getActiveDoNamesForMachine(db, machineId)
  } catch (err) {
    reqLog.error("failed to resolve machine doNames for agent provider switch", { err })
    return Response.json({ error: "failed to resolve machine" }, { status: 503 })
  }
  if (doNames.length === 0) return Response.json({ sent: 0 })

  const frame = JSON.stringify({ agentId, config, launchId, from, to })
  let delivered = 0
  let transientFailure = false
  for (const dn of doNames) {
    const doId = env.WS_DO.idFromName("community-machine:" + dn)
    const stub = env.WS_DO.get(doId)
    try {
      const res = await stub.fetch(new Request("http://internal/push-provider-switch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: frame,
      }))
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
    return Response.json({ error: "failed to forward agent provider switch" }, { status: 503 })
  }
  return Response.json({ sent: delivered })
}

export async function handleMachineRuntimeConfigUpdate({ request, env, url, traceId, log }: RouterContext): Promise<Response | null> {
  const match = url.pathname.match(/^\/community-machine\/by-id\/([^/]+)\/forward-agent-runtime-config-update$/)
  if (!match || request.method !== "POST") return null

  const machineId = decodeURIComponent(match[1])
  const reqLog = log.child({ traceId, machineId })
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
  if (Object.keys(raw).some((key) => key !== "agentId" && key !== "config")) {
    return Response.json({ error: "invalid payload" }, { status: 400 })
  }
  if (typeof raw.agentId !== "string" || raw.agentId.length === 0 || !raw.config || typeof raw.config !== "object") {
    return Response.json({ error: "invalid payload" }, { status: 400 })
  }

  let doNames: string[]
  try {
    const shared = await import("@alook/shared")
    const db = shared.createDb((env as unknown as { DB: D1Database }).DB)
    doNames = await queries.communityMachine.getActiveDoNamesForMachine(db, machineId)
  } catch (err) {
    reqLog.error("failed to resolve machine for runtime config update", { err })
    return Response.json({ error: "failed to resolve machine" }, { status: 503 })
  }
  if (doNames.length === 0) return Response.json({ sent: 0 })

  const frame = JSON.stringify({ agentId: raw.agentId, config: raw.config })
  let sent = 0
  let transientFailure = false
  for (const doName of doNames) {
    try {
      const stub = env.WS_DO.get(env.WS_DO.idFromName("community-machine:" + doName))
      const res = await stub.fetch(new Request("http://internal/push-runtime-config-update", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: frame,
      }))
      if (!res.ok) {
        transientFailure = true
        continue
      }
      const data = (await res.json()) as { sent?: unknown }
      if (typeof data.sent !== "number" || !Number.isFinite(data.sent) || data.sent < 0) {
        transientFailure = true
        continue
      }
      sent += data.sent
    } catch {
      transientFailure = true
    }
  }
  if (sent === 0 && transientFailure) {
    return Response.json({ error: "failed to forward runtime config update" }, { status: 503 })
  }
  return Response.json({ sent })
}
