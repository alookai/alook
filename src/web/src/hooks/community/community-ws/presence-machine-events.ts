import { appendBotAuditEvent, type AuditEvent } from "@/hooks/community/use-bot-audit-log"
import { getCommunityRuntime } from "@/stores/community/runtime"
import { replaceMachines } from "@/hooks/community/use-machines"
import type {
  CommunityBotAuditEvent,
  CommunityMachineCreated,
  CommunityMachineRemoved,
  CommunityMachineStatus,
  CommunityMachineSummary,
  CommunityMachineUpdated,
  CommunityPresenceUpdate,
  CommunityStatusUpdate,
} from "@alook/shared"
import { communityKeys } from "@/lib/query-keys"


import type { MachinesResponse } from "@/hooks/community/use-machines"
import type { PresenceMachineEventContext } from "@/hooks/community/community-ws/handler-context"

export function handlePresenceUpdate(
  event: CommunityPresenceUpdate,
  { queryClient }: PresenceMachineEventContext,
) {
  getCommunityRuntime(queryClient).ws.actions.setPresence(
    event.userId,
    event.online ? "online" : "offline",
  )
}

export function handleStatusUpdate(_event: CommunityStatusUpdate) {
}

// Push audit events into the bounded ring; the audit-log hook filters and
// prepends them into its React Query cache.
export function handleBotAuditEvent(event: CommunityBotAuditEvent, { queryClient }: PresenceMachineEventContext) {
  const row: AuditEvent = {
    id: event.id, kind: event.kind, payload: event.payload,
    sessionId: event.sessionId ?? null, launchId: event.launchId ?? null, createdAt: event.createdAt,
  }
  appendBotAuditEvent(queryClient, event.botId, row)
}

export function handleMachineCreated(
  event: CommunityMachineCreated,
  { queryClient }: PresenceMachineEventContext,
) {
  queryClient.setQueryData<MachinesResponse | undefined>(
    communityKeys.machines(),
    (prev) => {
      if (!prev) return { machines: [event.machine] }
      const idx = prev.machines.findIndex((m) => m.id === event.machine.id)
      if (idx === -1) return replaceMachines(prev, [event.machine, ...prev.machines])
      const next = prev.machines.slice()
      next[idx] = event.machine
      return replaceMachines(prev, next)
    },
  )
  getCommunityRuntime(queryClient).ui.actions.setPendingMachineTokenId(event.tokenId)
}

export function handleMachineStatus(
  event: CommunityMachineStatus,
  { queryClient }: PresenceMachineEventContext,
) {
  queryClient.setQueryData<MachinesResponse | undefined>(
    communityKeys.machines(),
    (prev) =>
      prev
        ? replaceMachines(prev, prev.machines.map((m) =>
            m.id === event.machineId
              ? { ...m, lastSeenAt: event.lastSeenAt, status: event.status }
              : m,
          ))
        : prev,
  )
}

export function handleMachineUpdated(
  event: CommunityMachineUpdated,
  { queryClient }: PresenceMachineEventContext,
) {
  queryClient.setQueryData<MachinesResponse | undefined>(
    communityKeys.machines(),
    (prev) => {
      if (!prev) return { machines: [event.machine] }
      const idx = prev.machines.findIndex((m) => m.id === event.machine.id)
      if (idx === -1) return replaceMachines(prev, [event.machine, ...prev.machines])
      const next: CommunityMachineSummary[] = prev.machines.slice()
      next[idx] = event.machine
      return replaceMachines(prev, next)
    },
  )
}

export function handleMachineRemoved(
  event: CommunityMachineRemoved,
  { queryClient }: PresenceMachineEventContext,
) {
  queryClient.setQueryData<MachinesResponse | undefined>(
    communityKeys.machines(),
    (prev) =>
      prev ? replaceMachines(prev, prev.machines.filter((m) => m.id !== event.machineId)) : prev,
  )
}
