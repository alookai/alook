import {
  createDb,
  HostReadyMessageSchema,
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
import { broadcastToAudience, notifyUserDO } from "./presence-typing"

/**
 * Order-normalized runtime JSON includes status and lastError, so a health
 * transition is observable even when id and version remain unchanged.
 */
function canonicalRuntimes(list: CommunityMachineRuntime[]): string {
  const sorted = [...list].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return JSON.stringify(
    sorted.map((runtime) => ({
      id: runtime.id,
      ...(runtime.version !== undefined ? { version: runtime.version } : {}),
      status: runtime.status ?? "healthy",
      ...(runtime.lastError !== undefined ? { lastError: runtime.lastError } : {}),
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
): Promise<boolean> {
  const readyParse = HostReadyMessageSchema.safeParse(parsed)
  if (!readyParse.success) return false
  const ready = readyParse.data
  try {
    const hostname = ready.hostname ?? ""
    const platform = ready.platform ?? ""
    const arch = ready.arch ?? ""
    const daemonVersion = ready.daemonVersion ?? ""
    const osRelease = ready.osRelease ?? ""
    const availableRuntimes: CommunityMachineRuntime[] = ready.runtimeReport

    const db = createDb(context.env.DB)
    const result = await queries.communityMachine.upsertMachineByMachineId(
      db,
      identity.userId,
      identity.machineId,
      { hostname, platform, arch, daemonVersion, osRelease, availableRuntimes }
    )
    if (!result) {
      context.log.warn("community machine row missing on ready", { machineId: identity.machineId })
      return true
    }
    const { machine, priorAvailableRuntimes, priorStatus } = result

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
    // Accept writes the handle first; ready refreshes it idempotently in case
    // the machine metadata or row identity changed during reconciliation.
    await context.ctx.storage.put<CommunityMachineHandle>(HANDLE_KEY, {
      userId: identity.userId,
      machineId: machine.id,
    })

    // Activation owns machine.created. Ready emits status only for an actual
    // offline → online transition, using the pre-upsert status returned by D1.
    if (priorStatus !== "online") {
      await notifyUserDO(context, identity.userId, {
        type: WS_EVENTS.MACHINE_STATUS,
        machineId: machine.id,
        status: "online",
        lastSeenAt: machine.lastSeenAt ?? new Date().toISOString(),
      }).catch(() => { })
    }

    const priorCanonical = canonicalRuntimes(priorAvailableRuntimes ?? [])
    const nextCanonical = canonicalRuntimes(availableRuntimes)
    // Runtime status/lastError drift is machine metadata drift and must reach
    // open clients even when the runtime set and versions are unchanged.
    if (priorCanonical !== nextCanonical) {
      await notifyUserDO(context, identity.userId, {
        type: WS_EVENTS.MACHINE_UPDATED,
        machine: summary,
      }).catch(() => { })
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

/** Compose a fresh D1 summary with the current DO-local overlay and notify its owner. */
export async function fanOutMachineUpdated(
  context: WsDurableContext,
  userId: string,
  machineId: string,
): Promise<void> {
  const db = createDb(context.env.DB)
  const row = await queries.communityMachine.getMachineByIdForUser(db, userId, machineId)
  if (!row) return
  const summary = await summaryWithOverlay(context, row)
  await notifyUserDO(context, userId, {
    type: WS_EVENTS.MACHINE_UPDATED,
    machine: summary,
  })
}
