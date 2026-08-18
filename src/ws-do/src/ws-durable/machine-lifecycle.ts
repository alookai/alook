import {
  COMMUNITY_MACHINE_HEARTBEAT_MS,
  COMMUNITY_MACHINE_OFFLINE_THRESHOLD_MS,
  DiagnosticCommandAckMessageSchema,
  MachineHeartbeatAckMessageSchema,
  WS_EVENTS,
  createDb,
  queries,
} from "@alook/shared"
import {
  DIAGNOSTIC_ALARM_HINT_KEY,
  HANDLE_KEY,
  IDENTITY_KEY,
} from "./internal"
import type {
  CommunityMachineConnectionState,
  CommunityMachineHandle,
  CommunityMachineIdentity,
  ConnectionState,
  WsDurableContext,
} from "./internal"
import { notifyUserDO } from "./presence-typing"

type DiagnosticAlarmHint = Readonly<{ machineId: string; deadlineAt: number }>

function authenticatedMachineSockets(context: WsDurableContext): WebSocket[] {
  return context.ctx.getWebSockets().filter((socket) => {
    const state = socket.deserializeAttachment() as ConnectionState
    return state?.type === "community-machine" && state.authenticated
  })
}

export async function scheduleHeartbeatAlarm(context: WsDurableContext): Promise<void> {
  const now = Date.now()
  const hint = await context.ctx.storage.get<DiagnosticAlarmHint>(DIAGNOSTIC_ALARM_HINT_KEY)
  const handle = await context.ctx.storage.get<CommunityMachineHandle>(HANDLE_KEY)
  const identity = await context.ctx.storage.get<CommunityMachineIdentity>(IDENTITY_KEY)
  const hasMachineSocket = authenticatedMachineSockets(context).length > 0
  const candidates: number[] = []
  if (hasMachineSocket || handle || identity) candidates.push(now + COMMUNITY_MACHINE_HEARTBEAT_MS)
  if (hint) candidates.push(Math.max(now, hint.deadlineAt))
  if (candidates.length === 0) {
    await context.ctx.storage.deleteAlarm()
    return
  }
  const want = Math.min(...candidates)
  const current = await context.ctx.storage.getAlarm()
  if (current == null || current > want) await context.ctx.storage.setAlarm(want)
}

export async function registerDiagnosticDeadline(
  context: WsDurableContext,
  machineId: string,
  deadlineAt: number,
): Promise<void> {
  const current = await context.ctx.storage.get<DiagnosticAlarmHint>(DIAGNOSTIC_ALARM_HINT_KEY)
  if (!current || current.machineId !== machineId || deadlineAt < current.deadlineAt) {
    await context.ctx.storage.put<DiagnosticAlarmHint>(DIAGNOSTIC_ALARM_HINT_KEY, {
      machineId,
      deadlineAt,
    })
  }
  await scheduleHeartbeatAlarm(context)
}

export async function handleMachineHeartbeatAck(
  _context: WsDurableContext,
  ws: WebSocket,
  parsed: unknown,
  identity: CommunityMachineIdentity,
): Promise<boolean> {
  const result = MachineHeartbeatAckMessageSchema.safeParse(parsed)
  if (!result.success) return false
  const state = ws.deserializeAttachment() as ConnectionState
  if (
    state?.type !== "community-machine" ||
    !state.authenticated ||
    state.userId !== identity.userId ||
    state.machineId !== identity.machineId ||
    state.controlHeartbeat !== true ||
    state.pendingHeartbeatNonce !== result.data.nonce
  ) return true
  ws.serializeAttachment({
    ...state,
    lastHeartbeatAckAt: Date.now(),
    pendingHeartbeatNonce: undefined,
  } satisfies CommunityMachineConnectionState)
  return true
}

export function handleDiagnosticCommandAck(
  context: WsDurableContext,
  ws: WebSocket,
  parsed: unknown,
  identity: CommunityMachineIdentity,
): boolean {
  const result = DiagnosticCommandAckMessageSchema.safeParse(parsed)
  if (!result.success) return false
  const state = ws.deserializeAttachment() as ConnectionState
  if (
    state?.type !== "community-machine" ||
    !state.authenticated ||
    state.userId !== identity.userId ||
    state.machineId !== identity.machineId
  ) return true
  context.log.debug("diagnostics command receipted", {
    machineId: identity.machineId,
    reportId: result.data.reportId,
  })
  return true
}

async function markIdentityOffline(
  context: WsDurableContext,
  identity: CommunityMachineIdentity,
  cause: "close" | "expire",
): Promise<boolean> {
  const db = createDb(context.env.DB)
  const result = await queries.communityMachineSession.transitionMachineSessionEpoch(db, {
    type: cause,
    epoch: identity,
  })
  if (result.type === "stale_epoch") return false
  await notifyUserDO(context, identity.userId, {
    type: WS_EVENTS.MACHINE_STATUS,
    machineId: identity.machineId,
    status: "offline",
    lastSeenAt: result.machine.lastSeenAt ?? new Date().toISOString(),
  }).catch(() => { })
  await context.ctx.storage.delete(HANDLE_KEY)
  await context.ctx.storage.delete(IDENTITY_KEY)
  return true
}

async function sweepDiagnosticDeadlines(context: WsDurableContext, nowMs: number): Promise<void> {
  const hint = await context.ctx.storage.get<DiagnosticAlarmHint>(DIAGNOSTIC_ALARM_HINT_KEY)
  if (!hint || hint.deadlineAt > nowMs) return
  try {
    const db = createDb(context.env.DB)
    await queries.communityDiagnosticReport.timeoutPendingDiagnosticReportsForMachine(db, {
      machineId: hint.machineId,
      nowMs,
    })
    const next = await queries.communityDiagnosticReport.getNextPendingDiagnosticDeadlineForMachine(db, {
      machineId: hint.machineId,
    })
    if (next == null) await context.ctx.storage.delete(DIAGNOSTIC_ALARM_HINT_KEY)
    else await context.ctx.storage.put<DiagnosticAlarmHint>(DIAGNOSTIC_ALARM_HINT_KEY, {
      machineId: hint.machineId,
      deadlineAt: next,
    })
  } catch (err) {
    context.log.warn("diagnostics deadline sweep failed", {
      machineId: hint.machineId,
      err: String(err),
    })
    await context.ctx.storage.put<DiagnosticAlarmHint>(DIAGNOSTIC_ALARM_HINT_KEY, {
      machineId: hint.machineId,
      deadlineAt: nowMs + COMMUNITY_MACHINE_HEARTBEAT_MS,
    })
  }
}

export async function handleCommunityMachineClose(
  context: WsDurableContext,
  state: CommunityMachineConnectionState,
  closingSocket: WebSocket,
): Promise<void> {
  context.log.info("community machine websocket closed", { machineId: state.machineId, userId: state.userId })
  const identity = await context.ctx.storage.get<CommunityMachineIdentity>(IDENTITY_KEY)
  if (!identity) {
    await scheduleHeartbeatAlarm(context)
    return
  }
  const replacementIsLive = authenticatedMachineSockets(context).some((socket) => {
    if (socket === closingSocket) return false
    const candidate = socket.deserializeAttachment() as CommunityMachineConnectionState
    return candidate.userId === state.userId && candidate.machineId === state.machineId
  })
  if (replacementIsLive) return
  try {
    const flipped = await markIdentityOffline(context, identity, "close")
    if (!flipped) {
      // The guarded row belongs to a newer credential (or is already
      // offline), so this close is terminal for the old DO identity.
      await context.ctx.storage.delete(HANDLE_KEY)
      await context.ctx.storage.delete(IDENTITY_KEY)
      return
    }
  } catch (err) {
    context.log.warn("session close transition failed", { err: String(err) })
    await context.ctx.storage.setAlarm(Date.now() + COMMUNITY_MACHINE_OFFLINE_THRESHOLD_MS)
  }
  await scheduleHeartbeatAlarm(context)
}

export async function handleMachineAlarm(context: WsDurableContext): Promise<void> {
  const now = Date.now()
  await sweepDiagnosticDeadlines(context, now)

  const liveMachines: Array<{ userId: string; machineId: string }> = []
  let expiredMachineSocket = false
  for (const ws of authenticatedMachineSockets(context)) {
    const state = ws.deserializeAttachment() as CommunityMachineConnectionState
    if (state.controlHeartbeat !== true) {
      expiredMachineSocket = true
      try { ws.close(1008, "Daemon upgrade required") } catch { }
      continue
    }
    const lastAckAt = state.lastHeartbeatAckAt ?? 0
    if (now - lastAckAt >= COMMUNITY_MACHINE_OFFLINE_THRESHOLD_MS) {
      expiredMachineSocket = true
      try { ws.close(1011, "Heartbeat lease expired") } catch { }
      continue
    }
    const nonce = state.pendingHeartbeatNonce ?? crypto.randomUUID()
    ws.serializeAttachment({ ...state, pendingHeartbeatNonce: nonce })
    try { ws.send(JSON.stringify({ type: "machine:heartbeat", nonce })) } catch { }
    liveMachines.push({ userId: state.userId, machineId: state.machineId })
  }

  if (liveMachines.length > 0) {
    const db = createDb(context.env.DB)
    const identity = await context.ctx.storage.get<CommunityMachineIdentity>(IDENTITY_KEY)
    let currentLeaseCount = 0
    let heartbeatUnavailable = false
    for (const machine of liveMachines) {
      if (identity && identity.userId === machine.userId && identity.machineId === machine.machineId) {
        try {
          const heartbeat = await queries.communityMachineSession.transitionMachineSessionEpoch(db, {
            type: "renew",
            epoch: identity,
          })
          if (heartbeat.type === "stale_epoch") {
            expiredMachineSocket = true
            for (const ws of authenticatedMachineSockets(context)) {
              const state = ws.deserializeAttachment() as CommunityMachineConnectionState
              if (state.userId === machine.userId && state.machineId === machine.machineId) {
                try { ws.close(1008, "Credential no longer current") } catch { }
              }
            }
            continue
          }
          currentLeaseCount++
          if (heartbeat.priorStatus === "offline") {
            await notifyUserDO(context, identity.userId, {
              type: WS_EVENTS.MACHINE_STATUS,
              machineId: identity.machineId,
              status: "online",
              lastSeenAt: heartbeat.machine.lastSeenAt ?? new Date().toISOString(),
            }).catch(() => { })
          }
        } catch (err) {
          heartbeatUnavailable = true
          context.log.warn("current-epoch heartbeat failed", { err: String(err) })
        }
      }
    }
    if (currentLeaseCount > 0 || heartbeatUnavailable) {
      await scheduleHeartbeatAlarm(context)
      return
    }
  }

  const stored = await context.ctx.storage.get<CommunityMachineHandle>(HANDLE_KEY)
  const identity = await context.ctx.storage.get<CommunityMachineIdentity>(IDENTITY_KEY)
  if (expiredMachineSocket && identity) {
    try {
      const flipped = await markIdentityOffline(context, identity, "expire")
      if (!flipped) {
        // A guarded no-op means this credential no longer owns the D1 row
        // (or another actor already won the offline transition). Forget only
        // this DO's stale lifecycle state; do not broadcast over the current
        // credential's presence.
        await context.ctx.storage.delete(HANDLE_KEY)
        await context.ctx.storage.delete(IDENTITY_KEY)
      }
    } catch (err) {
      context.log.warn("session expiry transition failed", { err: String(err) })
      await context.ctx.storage.setAlarm(now + COMMUNITY_MACHINE_HEARTBEAT_MS)
      return
    }
    await scheduleHeartbeatAlarm(context)
    return
  }
  if (!stored) {
    await scheduleHeartbeatAlarm(context)
    return
  }

  const db = createDb(context.env.DB)
  const machine = await queries.communityMachine.getMachineByIdForUser(db, stored.userId, stored.machineId)
  if (!machine) {
    await context.ctx.storage.delete(HANDLE_KEY)
    await context.ctx.storage.delete(IDENTITY_KEY)
    await scheduleHeartbeatAlarm(context)
    return
  }
  const lastSeen = machine.lastSeenAt ? Date.parse(machine.lastSeenAt) : 0
  const elapsed = now - lastSeen
  if (elapsed >= COMMUNITY_MACHINE_OFFLINE_THRESHOLD_MS) {
    if (identity) {
      let flipped: boolean
      try {
        flipped = await markIdentityOffline(context, identity, "expire")
      } catch (err) {
        context.log.warn("stale session expiry transition failed", { err: String(err) })
        await context.ctx.storage.setAlarm(now + COMMUNITY_MACHINE_HEARTBEAT_MS)
        return
      }
      // This is the legacy no-socket stale-row cleanup path. Once its D1
      // observation is stale, drop the local lifecycle record even when the
      // guarded flip was already won elsewhere. A thrown update is transient
      // and retains the identity for the retry path above.
      if (!flipped) {
        await context.ctx.storage.delete(HANDLE_KEY)
        await context.ctx.storage.delete(IDENTITY_KEY)
      }
    } else {
      await notifyUserDO(context, stored.userId, {
        type: WS_EVENTS.MACHINE_STATUS,
        machineId: stored.machineId,
        status: "offline",
        lastSeenAt: machine.lastSeenAt ?? new Date().toISOString(),
      }).catch(() => { })
      await context.ctx.storage.delete(HANDLE_KEY)
    }
    await scheduleHeartbeatAlarm(context)
    return
  }
  await context.ctx.storage.setAlarm(now + (COMMUNITY_MACHINE_OFFLINE_THRESHOLD_MS - elapsed))
}
