import { forwardMachineCommand } from "./machine-command-forwarding"

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

  const outcome = await forwardMachineCommand(env, machineId, "/push-model-switch", JSON.stringify({ agentId, config, launchId, from, to }))
  if (outcome.kind === "resolution-failed") {
    reqLog.error("failed to resolve machine doNames for agent model switch", { err: outcome.cause })
    return Response.json({ error: "failed to resolve machine" }, { status: 503 })
  }
  if (outcome.kind === "forward-failed") {
    return Response.json({ error: "failed to forward agent model switch" }, { status: 503 })
  }
  return Response.json({ sent: outcome.sent })
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

  const outcome = await forwardMachineCommand(env, machineId, "/push-provider-switch", JSON.stringify({ agentId, config, launchId, from, to }))
  if (outcome.kind === "resolution-failed") {
    reqLog.error("failed to resolve machine doNames for agent provider switch", { err: outcome.cause })
    return Response.json({ error: "failed to resolve machine" }, { status: 503 })
  }
  if (outcome.kind === "forward-failed") {
    return Response.json({ error: "failed to forward agent provider switch" }, { status: 503 })
  }
  return Response.json({ sent: outcome.sent })
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

  const outcome = await forwardMachineCommand(env, machineId, "/push-runtime-config-update", JSON.stringify({ agentId: raw.agentId, config: raw.config }))
  if (outcome.kind === "resolution-failed") {
    reqLog.error("failed to resolve machine for runtime config update", { err: outcome.cause })
    return Response.json({ error: "failed to resolve machine" }, { status: 503 })
  }
  if (outcome.kind === "forward-failed") {
    return Response.json({ error: "failed to forward runtime config update" }, { status: 503 })
  }
  return Response.json({ sent: outcome.sent })
}
