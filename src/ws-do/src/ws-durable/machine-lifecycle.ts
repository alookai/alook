import {
  COMMUNITY_MACHINE_HEARTBEAT_MS,
  COMMUNITY_MACHINE_OFFLINE_THRESHOLD_MS,
  WS_EVENTS,
  createDb,
  queries,
} from "@alook/shared"
import { HANDLE_KEY, IDENTITY_KEY } from "./internal"
import type {
  CommunityMachineConnectionState,
  CommunityMachineHandle,
  CommunityMachineIdentity,
  ConnectionState,
  WsDurableContext,
} from "./internal"
import { notifyUserDO } from "./presence-typing"

export async function scheduleHeartbeatAlarm(context: WsDurableContext): Promise<void> {
  const current = await context.ctx.storage.getAlarm()
  const want = Date.now() + COMMUNITY_MACHINE_HEARTBEAT_MS
  if (current == null || current > want) {
    await context.ctx.storage.setAlarm(want)
  }
}

export async function handleCommunityMachineClose(
  context: WsDurableContext,
  state: CommunityMachineConnectionState,
  closingSocket: WebSocket,
): Promise<void> {
  context.log.info("community machine websocket closed", { machineId: state.machineId, userId: state.userId })
  const identity = await context.ctx.storage.get<CommunityMachineIdentity>(IDENTITY_KEY)
  if (!identity) return
  const replacementIsLive = context.ctx.getWebSockets().some((socket) => {
    if (socket === closingSocket) return false
    const candidate = socket.deserializeAttachment() as ConnectionState
    return candidate?.type === "community-machine"
      && candidate.authenticated
      && candidate.userId === state.userId
      && candidate.machineId === state.machineId
  })
  if (replacementIsLive) return
  try {
    const db = createDb(context.env.DB)
    const flipped = await queries.communityMachine.markMachineOffline(db, {
      userId: identity.userId,
      machineId: identity.machineId,
      credentialHash: identity.credentialHash,
    })
    if (flipped) {
      await notifyUserDO(context, identity.userId, {
        type: WS_EVENTS.MACHINE_STATUS,
        machineId: identity.machineId,
        status: "offline",
        lastSeenAt: flipped.lastSeenAt ?? new Date().toISOString(),
      }).catch(() => { })
      await context.ctx.storage.deleteAlarm()
      await context.ctx.storage.delete(HANDLE_KEY)
      await context.ctx.storage.delete(IDENTITY_KEY)
    } else {
      await context.ctx.storage.setAlarm(Date.now() + COMMUNITY_MACHINE_OFFLINE_THRESHOLD_MS)
    }
  } catch (err) {
    context.log.warn("markMachineOffline failed on webSocketClose", { err: String(err) })
    await context.ctx.storage.setAlarm(Date.now() + COMMUNITY_MACHINE_OFFLINE_THRESHOLD_MS)
  }
}

export async function handleMachineAlarm(context: WsDurableContext): Promise<void> {
  const sockets = context.ctx.getWebSockets()
  const liveMachines: Array<{ userId: string; machineId: string }> = []
  for (const ws of sockets) {
    const s = ws.deserializeAttachment() as ConnectionState
    if (s?.type === "community-machine" && s.authenticated) {
      liveMachines.push({ userId: s.userId, machineId: s.machineId })
    }
  }

  if (liveMachines.length > 0) {
    const db = createDb(context.env.DB)
    const identity = await context.ctx.storage.get<CommunityMachineIdentity>(IDENTITY_KEY)
    for (const m of liveMachines) {
      try {
        await queries.communityMachine.touchMachineHeartbeat(db, m.userId, m.machineId)
      } catch { /* ok */ }
      if (identity && identity.userId === m.userId && identity.machineId === m.machineId) {
        try {
          const backfilled = await queries.communityMachine.markMachineOnlineIfOffline(db, {
            userId: identity.userId,
            machineId: identity.machineId,
            credentialHash: identity.credentialHash,
          })
          if (backfilled) {
            await notifyUserDO(context, identity.userId, {
              type: WS_EVENTS.MACHINE_STATUS,
              machineId: identity.machineId,
              status: "online",
              lastSeenAt: backfilled.lastSeenAt ?? new Date().toISOString(),
            }).catch(() => { })
          }
        } catch (err) {
          context.log.warn("markMachineOnlineIfOffline (alarm live-WS) failed", { err: String(err) })
        }
      }
    }
    await context.ctx.storage.setAlarm(Date.now() + COMMUNITY_MACHINE_HEARTBEAT_MS)
    return
  }

  const stored = await context.ctx.storage.get<CommunityMachineHandle>(HANDLE_KEY)
  if (!stored) return
  const identity = await context.ctx.storage.get<CommunityMachineIdentity>(IDENTITY_KEY)
  const db = createDb(context.env.DB)
  const machine = await queries.communityMachine.getMachineByIdForUser(
    db,
    stored.userId,
    stored.machineId
  )
  if (!machine) {
    await context.ctx.storage.delete(HANDLE_KEY)
    await context.ctx.storage.delete(IDENTITY_KEY)
    return
  }
  const lastSeen = machine.lastSeenAt ? Date.parse(machine.lastSeenAt) : 0
  const elapsed = Date.now() - lastSeen
  if (elapsed >= COMMUNITY_MACHINE_OFFLINE_THRESHOLD_MS) {
    if (identity) {
      try {
        const flipped = await queries.communityMachine.markMachineOffline(db, {
          userId: identity.userId,
          machineId: identity.machineId,
          credentialHash: identity.credentialHash,
        })
        if (flipped) {
          await notifyUserDO(context, stored.userId, {
            type: WS_EVENTS.MACHINE_STATUS,
            machineId: stored.machineId,
            status: "offline",
            lastSeenAt: flipped.lastSeenAt ?? new Date().toISOString(),
          }).catch(() => { })
        }
      } catch (err) {
        context.log.warn("markMachineOffline (alarm stale-flip) failed", { err: String(err) })
      }
    } else {
      await notifyUserDO(context, stored.userId, {
        type: WS_EVENTS.MACHINE_STATUS,
        machineId: stored.machineId,
        status: "offline",
        lastSeenAt: machine.lastSeenAt ?? new Date().toISOString(),
      }).catch(() => { })
    }
    await context.ctx.storage.delete(HANDLE_KEY)
    await context.ctx.storage.delete(IDENTITY_KEY)
    return
  }
  await context.ctx.storage.setAlarm(Date.now() + (COMMUNITY_MACHINE_OFFLINE_THRESHOLD_MS - elapsed))
}
