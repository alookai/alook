import { publishMachinePresence } from "./machine-presence"
import { PII_CAPABILITY } from "@alook/shared"
import {
  CONTROL_HEARTBEAT_CAPABILITY,
  MACHINE_STOP_CAPABILITY,
  MACHINE_REFRESH_CAPABILITY,
  RUNTIME_MODEL_DISCOVERY_CAPABILITY,
  createDb,
  HostReadyMessageSchema,
  ProviderQuotaSnapshotListSchema,
  dayKeyInTimeZone,
  queries,
  WS_EVENTS,
} from "@alook/shared"
import type { CommunityMachineRuntime, CommunityMachineSummary } from "@alook/shared"
import {
  HANDLE_KEY,
  IDENTITY_KEY,
  RUNTIME_ERROR_KEY,
} from "./internal"
import type {
  CommunityMachineHandle,
  CommunityMachineIdentity,
  WsDurableContext,
} from "./internal"
import { scheduleHeartbeatAlarm } from "./machine-lifecycle"
import { broadcastToAudience } from "./presence-typing"
import { prepareQuotaReplace } from "./provider-telemetry-persistence"

function canonicalRuntimes(list: CommunityMachineRuntime[]): string {
  const sorted = [...list].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return JSON.stringify(
    sorted.map((runtime) => ({
      id: runtime.id,
      ...(runtime.version !== undefined ? { version: runtime.version } : {}),
      status: runtime.status ?? "healthy",
      ...(runtime.lastError !== undefined ? { lastError: runtime.lastError } : {}),
      ...(runtime.reasoning !== undefined ? { reasoning: runtime.reasoning } : {}),
    }))
  )
}

async function summaryWithOverlay(
  context: WsDurableContext,
  row: Parameters<typeof queries.communityMachine.toSummary>[0],
): Promise<CommunityMachineSummary> {
  // The runtime error is transient DO-local state, not a D1 field. Overlay it
  // only at summary construction so persistence stays authoritative.
  const base = queries.communityMachine.toSummary(row)
  const overlay = await context.ctx.storage.get<{
    requested: string
    available: string[]
    at: string
  }>(RUNTIME_ERROR_KEY)
  return overlay ? { ...base, lastRuntimeError: overlay } : base
}

/**
 * Only strict flat ready frames reach persistence. A missing machine row
 * stops before reconciliation, handle refresh, notification, or alarm work.
 * Every write-side failure is classified and swallowed so the live socket
 * remains available for the next heartbeat.
 */
export async function handleReadyFrame(
  context: WsDurableContext,
  parsed: unknown,
  identity: CommunityMachineIdentity,
  ws: WebSocket,
): Promise<boolean> {
  const readyParse = HostReadyMessageSchema
    .omit({ providerQuotas: true })
    .passthrough()
    .safeParse(parsed)
  if (!readyParse.success) return false
  const ready = readyParse.data
  const raw = parsed as Record<string, unknown>
  const quotaParse = ProviderQuotaSnapshotListSchema.safeParse(raw.providerQuotas)
  const providerQuotas = quotaParse.success ? quotaParse.data : []
  const controlHeartbeat = ready.capabilities.includes(CONTROL_HEARTBEAT_CAPABILITY)
  const state = ws.deserializeAttachment() as import("./internal").ConnectionState
  if (
    state?.type === "community-machine" &&
    state.authenticated &&
    state.userId === identity.userId &&
    state.machineId === identity.machineId
  ) {
    ws.serializeAttachment({
      ...state,
      controlHeartbeat,
      pii: ready.capabilities.includes(PII_CAPABILITY),
      modelDiscovery: ready.capabilities.includes(RUNTIME_MODEL_DISCOVERY_CAPABILITY),
      machineStop: ready.capabilities.includes(MACHINE_STOP_CAPABILITY),
      machineRefresh: ready.capabilities.includes(MACHINE_REFRESH_CAPABILITY),
      ...(controlHeartbeat ? { lastHeartbeatAckAt: Date.now() } : {}),
      pendingHeartbeatNonce: undefined,
    })
  }
  if (!controlHeartbeat) {
    try {
      ws.send(JSON.stringify({
        type: "error",
        code: "UPGRADE_REQUIRED",
        reason: "daemon does not support the required heartbeat lease",
      }))
    } catch { }
    try { ws.close(1008, "Daemon upgrade required") } catch { }
    return true
  }
  try {
    const hostname = ready.hostname ?? ""
    const platform = ready.platform ?? ""
    const arch = ready.arch ?? ""
    const daemonVersion = ready.daemonVersion ?? ""
    const osRelease = ready.osRelease ?? ""
    let timeZone: string | undefined
    if (ready.timeZone) {
      try {
        dayKeyInTimeZone(new Date(), ready.timeZone)
        timeZone = ready.timeZone
      } catch { }
    }
    const availableRuntimes: CommunityMachineRuntime[] = ready.runtimeReport

    const db = createDb(context.env.DB)
    const result = await queries.communityMachineSession.transitionMachineSessionEpoch(db, {
      type: "ready",
      epoch: identity,
      metadata: { hostname, platform, arch, daemonVersion, osRelease, timeZone, availableRuntimes },
    })
    if (result.type === "stale_epoch") {
      context.log.warn("community machine epoch rejected on ready", { machineId: identity.machineId })
      try {
        ws.send(JSON.stringify({ type: "error", code: "AUTH_REJECTED" }))
      } catch { }
      try { ws.close(1008, "Credential no longer current") } catch { }
      return true
    }
    const { machine, priorAvailableRuntimes, priorDaemonVersion, priorStatus } = result
    const acceptedQuotas = providerQuotas.filter((snapshot) =>
      ready.runtimeReport.some((runtime) => runtime.id === snapshot.agentBackendId)
    )
    if (acceptedQuotas.length > 0) {
      const nowIso = new Date().toISOString()
      try {
        await context.env.DB.batch(
          acceptedQuotas.map((snapshot) => prepareQuotaReplace(context.env.DB, identity, snapshot, nowIso))
        )
      } catch (err) {
        // Quota is an optional sibling of the existing ready lifecycle. A
        // telemetry-only persistence failure must not strand reconciliation,
        // heartbeat scheduling, or machine status after ready already won its
        // authenticated session transition.
        context.log.warn("provider_quota_dropped", {
          frame_type: "ready",
          machineId: identity.machineId,
          err: err instanceof Error ? err : new Error(String(err)),
        })
      }
    }

    // Reconciliation is the coarse safety net for an activity frame lost
    // during disconnect. It clears only stale system-owned activity pills;
    // owner-authored custom statuses remain untouched in the query layer.
    const activityChanges = await queries.communityMachine.reconcileBotActivityFromRunningAgents(
      db,
      machine.id,
      ready.runningAgents
    )
    await Promise.allSettled(
      activityChanges.map(({ botUserId, statusEmoji, statusText }) =>
        broadcastToAudience(context, botUserId, {
          type: WS_EVENTS.STATUS_UPDATE,
          userId: botUserId,
          statusEmoji,
          statusText,
        })
      )
    )

    const summary = await summaryWithOverlay(context, machine)

    await context.ctx.storage.put<CommunityMachineHandle>(HANDLE_KEY, {
      userId: identity.userId,
      machineId: machine.id,
    })

    const priorCanonical = canonicalRuntimes(priorAvailableRuntimes ?? [])
    const nextCanonical = canonicalRuntimes(availableRuntimes)
    // Runtime status/lastError drift is machine metadata drift and must reach
    // open clients even when the runtime set and versions are unchanged.
    if (priorStatus !== "online" || priorCanonical !== nextCanonical || priorDaemonVersion !== daemonVersion) {
      await publishMachinePresence(context, identity.userId, {
        type: WS_EVENTS.MACHINE_UPDATED,
        machine: summary,
      }, priorStatus !== "online")
    }

    await scheduleHeartbeatAlarm(context)
  } catch (err) {
    context.log.warn("ws_frame_dropped", {
      category: "ws_frame_dropped",
      frame_type: "ready",
      phase: "write",
      machineId: identity.machineId,
      err: err instanceof Error ? err : new Error(String(err)),
    })
  }
  return true
}

/**
 * Wakes and force-close optimistically clear the transient runtime error. A
 * stored overlay is deleted before the fresh summary is fanned out; missing
 * identity or a missing row leaves the operation a safe no-op.
 */
export async function clearRuntimeErrorOverlay(context: WsDurableContext): Promise<void> {
  const overlay = await context.ctx.storage.get(RUNTIME_ERROR_KEY)
  if (overlay === undefined) return
  await context.ctx.storage.delete(RUNTIME_ERROR_KEY)
  const identity = await context.ctx.storage.get<CommunityMachineIdentity>(IDENTITY_KEY)
  if (!identity) return
  await fanOutMachineUpdated(context, identity.userId, identity.machineId).catch(() => { })
}

export async function fanOutMachineUpdated(
  context: WsDurableContext,
  userId: string,
  machineId: string,
): Promise<void> {
  const db = createDb(context.env.DB)
  const row = await queries.communityMachine.getMachineByIdForUser(db, userId, machineId)
  if (!row) return
  const summary = await summaryWithOverlay(context, row)
  await publishMachinePresence(context, userId, {
    type: WS_EVENTS.MACHINE_UPDATED,
    machine: summary,
  })
}
