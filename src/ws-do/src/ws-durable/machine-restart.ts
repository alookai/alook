import {
  AgentSessionMessageSchema,
  createDb,
  queries,
  SessionErrorFrameSchema,
  withD1Retry,
  WS_EVENTS,
} from "@alook/shared"
import { handleFrameForBoundBot } from "./bound-bot-frame"
import {
  normalizeRestartAttribution,
  restartPendingKey,
  RUNTIME_ERROR_KEY,
} from "./internal"
import type {
  CommunityMachineIdentity,
  ResetTrigger,
  RestartAttribution,
  WsDurableContext,
} from "./internal"

export type MachineRestartHooks = Readonly<{
  fanOutMachineUpdated: (userId: string, machineId: string) => Promise<void>
  notifyUser: (userId: string, payload: unknown) => Promise<void>
}>

export async function handleAgentCommandAck(
  context: WsDurableContext,
  parsed: unknown,
  identity: CommunityMachineIdentity,
): Promise<boolean> {
  if (
    !parsed || typeof parsed !== "object" || !("type" in parsed) ||
    typeof (parsed as { type: unknown }).type !== "string" ||
    (
      (parsed as { type: string }).type !== "agent_wake_ack" &&
      (parsed as { type: string }).type !== "agent_stopped_ack"
    )
  ) return false

  const ack = parsed as {
    type: string
    agentId?: string
    launchId?: string
    status?: string
    error?: { code?: string; message?: string }
  }
  if (ack.status === "error") {
    context.log.warn("agent command ack error", {
      machineId: identity.machineId,
      type: ack.type,
      agentId: ack.agentId,
      code: ack.error?.code,
      message: ack.error?.message,
    })
    if (ack.type === "agent_wake_ack" && typeof ack.launchId === "string" && ack.launchId.length > 0) {
      await evictPendingReset(context, ack.launchId)
    }
  } else if (ack.status === "ok") {
    context.log.debug("agent command ack ok", {
      machineId: identity.machineId,
      type: ack.type,
      agentId: ack.agentId,
    })
  }
  return true
}

export async function handleSessionErrorFrame(
  context: WsDurableContext,
  parsed: unknown,
  identity: CommunityMachineIdentity,
  hooks: MachineRestartHooks,
): Promise<boolean> {
  const sessionErrorParse = SessionErrorFrameSchema.safeParse(parsed)
  if (!sessionErrorParse.success || sessionErrorParse.data.code !== "runtime_not_available") return false

  const payload = sessionErrorParse.data.payload ?? {}
  const requested = typeof payload.requested === "string" ? payload.requested : ""
  const availableRaw = Array.isArray(payload.available) ? payload.available : []
  const available = availableRaw.filter((value): value is string => typeof value === "string")
  const overlay = { requested, available, at: new Date().toISOString() }
  await context.ctx.storage.put(RUNTIME_ERROR_KEY, overlay)
  const launchId = sessionErrorParse.data.launchId
  if (typeof launchId === "string" && launchId.length > 0) {
    await evictPendingReset(context, launchId)
  }
  await hooks.fanOutMachineUpdated(identity.userId, identity.machineId).catch(() => { })
  return true
}

export async function handleAgentSessionFrame(
  context: WsDurableContext,
  parsed: unknown,
  identity: CommunityMachineIdentity,
  hooks: MachineRestartHooks,
): Promise<boolean> {
  const sessionParse = AgentSessionMessageSchema.safeParse(parsed)
  if (!sessionParse.success) return false

  const { agentId, launchId } = sessionParse.data
  const stored = await context.ctx.storage.get<ResetTrigger | RestartAttribution>(restartPendingKey(launchId))
  if (!stored) return true
  const attribution = normalizeRestartAttribution(stored)
  await evictPendingReset(context, launchId)
  const db = createDb(context.env.DB)
  await handleFrameForBoundBot(context, {
    frameType: "agent_session",
    agentId,
    machineId: identity.machineId,
    writeCategory: "ws_frame_dropped_write",
    resolveBinding: () => withD1Retry(
      () => queries.communityBot.getBotBindingWithOwner(db, agentId),
      { route: "ws-do:agent-session-binding" },
    ),
    isMatch: (binding) => binding.machineId === identity.machineId,
    write: async (binding) => {
      const inserted = attribution.kind === "nap"
        ? await queries.communityBotAuditLog.insertBotAuditNap(db, { botId: agentId, launchId })
        : attribution.kind === "session_reset"
          ? await queries.communityBotAuditLog.insertBotAuditSessionReset(db, {
              botId: agentId,
              launchId,
              trigger: attribution.trigger,
            })
          : attribution.kind === "model_switch"
            ? await queries.communityBotAuditLog.insertBotAuditModelChanged(db, {
                botId: agentId,
                launchId,
                from: attribution.from,
                to: attribution.to,
              })
            : await queries.communityBotAuditLog.insertBotAuditProviderChanged(db, {
                botId: agentId,
                launchId,
                from: attribution.from,
                to: attribution.to,
              })
      if (!inserted) return
      if (attribution.kind !== "model_switch") {
        await queries.communityBot.touchBotRefreshContext(db, agentId, inserted.createdAt)
      }
      const payload = attribution.kind === "nap"
        ? { trigger: "nap" }
        : attribution.kind === "session_reset"
          ? { trigger: attribution.trigger }
          : { from: attribution.from, to: attribution.to }
      await hooks.notifyUser(binding.ownerUserId, {
        type: WS_EVENTS.BOT_AUDIT_EVENT,
        botId: agentId,
        id: inserted.id,
        kind: attribution.kind === "provider_switch"
          ? "provider_changed"
          : attribution.kind === "model_switch"
            ? "model_changed"
            : attribution.kind,
        payload,
        sessionId: null,
        launchId,
        createdAt: inserted.createdAt,
      }).catch(() => { })
    },
  })
  return true
}

export async function recordPendingRestarts(
  context: WsDurableContext,
  body: string,
): Promise<void> {
  let frame: unknown
  try {
    frame = JSON.parse(body)
  } catch {
    return
  }
  if (!frame || typeof frame !== "object") return
  const parsed = frame as { type?: unknown }
  const put = async (launchId: unknown, attribution: RestartAttribution) => {
    if (typeof launchId !== "string" || launchId.length === 0) return
    await context.ctx.storage.put<RestartAttribution>(restartPendingKey(launchId), attribution)
  }
  if (parsed.type === "agent:reset") {
    await put((parsed as { launchId?: unknown }).launchId, { kind: "session_reset", trigger: "single" })
  } else if (parsed.type === "agent:nap") {
    await put((parsed as { launchId?: unknown }).launchId, { kind: "nap" })
  } else if (parsed.type === "machine:reset_all") {
    const resets = (parsed as { resets?: unknown }).resets
    if (Array.isArray(resets)) {
      for (const reset of resets) {
        if (reset && typeof reset === "object") {
          await put((reset as { launchId?: unknown }).launchId, { kind: "session_reset", trigger: "reset_all" })
        }
      }
    }
  }
}

async function evictPendingReset(context: WsDurableContext, launchId: string): Promise<void> {
  await context.ctx.storage.delete(restartPendingKey(launchId))
}
