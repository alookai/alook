import { createDb, queries, WS_EVENTS, validateCommunityWsEvent, type CommunityMachineStatus, type CommunityMachineUpdated } from "@alook/shared"
import { logCommunityBrowserEventRejected } from "../community-browser-event-ingress"
import type { WsDurableContext } from "./internal"
import { broadcastPresence, notifyUserDO } from "./presence-typing"

export async function publishMachinePresence(
  context: WsDurableContext, userId: string,
  payload: CommunityMachineStatus | CommunityMachineUpdated,
  machineOnlineTransition = false,
): Promise<void> {
  // Presence effects require the same admitted event as private owner delivery.
  const normalized = validateCommunityWsEvent(payload)
  if (!normalized.ok) {
    logCommunityBrowserEventRejected(context.log, "ws-do-producer", normalized)
    return
  }
  const event = normalized.event
  await notifyUserDO(context, userId, event)
  const status = event.type === WS_EVENTS.MACHINE_STATUS
    ? { machineId: event.machineId, online: event.status === "online" }
    : event.type === WS_EVENTS.MACHINE_UPDATED && machineOnlineTransition
      ? { machineId: event.machine.id, online: event.machine.status === "online" }
      : null
  if (!status) return
  try {
    const bots = await queries.communityBot.listBotsForMachine(createDb(context.env.DB), status.machineId)
    await Promise.allSettled(bots.map((bot) => broadcastPresence(context, bot.id, status.online)))
  } catch (err) {
    context.log.error("machine presence fan-out failed", { err: String(err), userId })
  }
}
