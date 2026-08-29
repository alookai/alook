import { createDb, DiagnosticCollectCommandSchema, queries } from "@alook/shared"
import {
  HANDLE_KEY,
  IDENTITY_KEY,
  RUNTIME_ERROR_KEY,
  restartPendingKey,
} from "./internal"
import type {
  CommunityMachineHandle,
  CommunityMachineIdentity,
  ConnectionState,
  RestartAttribution,
  WsDurableContext,
} from "./internal"
import { registerDiagnosticDeadline, scheduleHeartbeatAlarm } from "./machine-lifecycle"

export type MachineControlHooks = Readonly<{
  recordPendingRestarts: (body: string) => Promise<void>
  clearRuntimeErrorOverlay: () => Promise<void>
  fanOutMachineUpdated: (userId: string, machineId: string) => Promise<void>
}>

export async function handleMachineControlFetch(
  context: WsDurableContext,
  request: Request,
  url: URL,
  hooks: MachineControlHooks,
): Promise<Response | null> {
  if (url.pathname === "/force-close" && request.method === "POST") {
    const closed = await forceCloseCommunityMachine(context, hooks.fanOutMachineUpdated)
    return new Response(JSON.stringify({ closed }), {
      headers: { "Content-Type": "application/json" },
    })
  }

  if (url.pathname === "/push" && request.method === "POST") {
    const body = await request.text()
    const sent = forwardToCommunityMachine(context, body)
    if (sent > 0) await hooks.recordPendingRestarts(body)
    return new Response(JSON.stringify({ sent }), {
      headers: { "Content-Type": "application/json" },
    })
  }

  if (
    request.method === "POST" &&
    (url.pathname === "/push-model-switch" || url.pathname === "/push-provider-switch")
  ) {
    let payload: unknown
    try {
      payload = await request.json()
    } catch {
      return new Response(JSON.stringify({ sent: 0 }), { status: 400 })
    }
    if (!payload || typeof payload !== "object") {
      return new Response(JSON.stringify({ sent: 0 }), { status: 400 })
    }
    const raw = payload as Record<string, unknown>
    const { agentId, config, launchId, from, to } = raw
    if (
      typeof agentId !== "string" || agentId.length === 0 ||
      typeof launchId !== "string" || launchId.length === 0 ||
      !config || typeof config !== "object"
    ) {
      return new Response(JSON.stringify({ sent: 0 }), { status: 400 })
    }
    const providerSwitch = url.pathname === "/push-provider-switch"
    if (
      providerSwitch
        ? typeof from !== "string" || from.length === 0 || typeof to !== "string" || to.length === 0
        : (from !== null && typeof from !== "string") || (to !== null && typeof to !== "string")
    ) {
      return new Response(JSON.stringify({ sent: 0 }), { status: 400 })
    }
    const frame = JSON.stringify({
      type: providerSwitch ? "agent:reset" : "agent:model_switch",
      agentId,
      config,
      launchId,
    })
    const sent = forwardToCommunityMachine(context, frame)
    if (sent > 0) {
      const attribution: RestartAttribution = providerSwitch
        ? { kind: "provider_switch", from: from as string, to: to as string }
        : { kind: "model_switch", from: from as string | null, to: to as string | null }
      await context.ctx.storage.put<RestartAttribution>(restartPendingKey(launchId), attribution)
    }
    return new Response(JSON.stringify({ sent }), {
      headers: { "Content-Type": "application/json" },
    })
  }

  if (url.pathname === "/push-runtime-config-update" && request.method === "POST") {
    let payload: unknown
    try {
      payload = await request.json()
    } catch {
      return new Response(JSON.stringify({ sent: 0 }), { status: 400 })
    }
    const raw = payload && typeof payload === "object" ? payload as Record<string, unknown> : null
    if (
      !raw ||
      Object.keys(raw).some((key) => key !== "agentId" && key !== "config") ||
      typeof raw.agentId !== "string" ||
      raw.agentId.length === 0 ||
      !raw.config ||
      typeof raw.config !== "object"
    ) {
      return new Response(JSON.stringify({ sent: 0 }), { status: 400 })
    }
    const sent = forwardToCommunityMachine(context, JSON.stringify({
      type: "agent:runtime_config_update",
      agentId: raw.agentId,
      config: raw.config,
    }))
    return new Response(JSON.stringify({ sent }), {
      headers: { "Content-Type": "application/json" },
    })
  }

  if (url.pathname === "/forward-agent-wake" && request.method === "POST") {
    const body = await request.text()
    const attempted = forwardToCommunityMachine(context, body)
    await hooks.clearRuntimeErrorOverlay().catch(() => { })
    return new Response(JSON.stringify({ attempted, sent: attempted }), {
      headers: { "Content-Type": "application/json" },
    })
  }

  if (url.pathname === "/register-diagnostic-deadline" && request.method === "POST") {
    let raw: unknown
    try {
      raw = await request.json()
    } catch {
      return new Response(JSON.stringify({ registered: false }), { status: 400 })
    }
    const machineId = url.searchParams.get("machineId")
    const record = raw && typeof raw === "object" ? raw as Record<string, unknown> : null
    if (
      !machineId ||
      !record ||
      Object.keys(record).length !== 1 ||
      !Number.isSafeInteger(record.deadlineAt) ||
      (record.deadlineAt as number) < 0
    ) {
      return new Response(JSON.stringify({ registered: false }), { status: 400 })
    }
    await registerDiagnosticDeadline(context, machineId, record.deadlineAt as number)
    return new Response(JSON.stringify({ registered: true }), {
      headers: { "Content-Type": "application/json" },
    })
  }

  if (url.pathname === "/forward-diagnostics-collect" && request.method === "POST") {
    let raw: unknown
    try {
      raw = await request.json()
    } catch {
      return new Response(JSON.stringify({ attempted: 0 }), { status: 400 })
    }
    const command = DiagnosticCollectCommandSchema.safeParse(raw)
    if (!command.success) {
      return new Response(JSON.stringify({ attempted: 0 }), { status: 400 })
    }
    const attempted = forwardToCommunityMachine(context, JSON.stringify(command.data))
    return new Response(JSON.stringify({ attempted, sent: attempted }), {
      headers: { "Content-Type": "application/json" },
    })
  }

  return null
}

export async function acceptCommunityMachineWebSocket(
  context: WsDurableContext,
  bearer: string,
): Promise<Response> {
  const db = createDb(context.env.DB)
  const hash = await queries.communityMachine.hashCredential(bearer)
  let auth: {
    credentialId: string
    userId: string
    machineId: string
    credentialHash: string
    doName: string
  } | null = null
  try {
    auth = await queries.communityMachine.findCredentialByHash(db, hash)
  } catch (err) {
    context.log.warn("community machine auth lookup threw", { err: String(err) })
    return new Response("auth lookup unavailable", { status: 503 })
  }
  if (!auth) {
    return new Response("credential revoked or unknown", { status: 401 })
  }

  const pair = new WebSocketPair()
  const [client, server] = Object.values(pair)
  context.ctx.acceptWebSocket(server)

  server.serializeAttachment({
    type: "community-machine",
    machineId: auth.machineId,
    userId: auth.userId,
    authenticated: true,
  } as ConnectionState)

  const identity: CommunityMachineIdentity = {
    userId: auth.userId,
    machineId: auth.machineId,
    credentialHash: auth.credentialHash,
  }
  await context.ctx.storage.put(IDENTITY_KEY, identity)
  await context.ctx.storage.put<CommunityMachineHandle>(HANDLE_KEY, {
    userId: auth.userId,
    machineId: auth.machineId,
  })
  await scheduleHeartbeatAlarm(context)

  return new Response(null, { status: 101, webSocket: client })
}

async function forceCloseCommunityMachine(
  context: WsDurableContext,
  fanOutMachineUpdated: (userId: string, machineId: string) => Promise<void>,
): Promise<number> {
  const identity = await context.ctx.storage.get<CommunityMachineIdentity>(IDENTITY_KEY)
  let closed = 0
  for (const ws of context.ctx.getWebSockets()) {
    const s = ws.deserializeAttachment() as ConnectionState
    if (s?.type === "community-machine") {
      try {
        ws.send(JSON.stringify({ type: "error", code: "AUTH_REJECTED" }))
        ws.close(1008, "Revoked")
        closed++
      } catch { /* ok */ }
    }
  }
  await context.ctx.storage.delete(IDENTITY_KEY)
  await context.ctx.storage.delete(HANDLE_KEY)
  const hadError = (await context.ctx.storage.get(RUNTIME_ERROR_KEY)) !== undefined
  await context.ctx.storage.delete(RUNTIME_ERROR_KEY)
  if (identity && hadError) {
    await fanOutMachineUpdated(identity.userId, identity.machineId).catch(() => { })
  }
  return closed
}

function rejectCommunityMachine(ws: WebSocket, reason: string): void {
  try {
    ws.send(JSON.stringify({ type: "error", code: "AUTH_REJECTED", reason }))
  } catch { /* ok */ }
  try { ws.close(1008, "Unauthorized") } catch { /* ok */ }
}

function forwardToCommunityMachine(context: WsDurableContext, message: string): number {
  let sent = 0
  for (const ws of context.ctx.getWebSockets()) {
    const state = ws.deserializeAttachment() as ConnectionState
    if (state?.type === "community-machine" && state.authenticated) {
      try {
        ws.send(message)
        sent++
      } catch { /* ok */ }
    }
  }
  return sent
}
