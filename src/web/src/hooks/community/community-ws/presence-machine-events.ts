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
import { useCommunityStore } from "@/stores/community"
import { useCommunityWsStore } from "@/stores/community/ws"
import type { MachinesResponse } from "@/hooks/community/use-machines"
import type { PresenceMachineEventContext } from "@/hooks/community/community-ws/handler-context"

// Presence has no query cache; write to the WS store.
export function handlePresenceUpdate(
  event: CommunityPresenceUpdate,
  { cbs }: PresenceMachineEventContext,
) {
  useCommunityWsStore.getState().setPresence(event.userId, event.online)
  cbs.onPresence?.(event)
}

// Status uses the same WS-store overlay pattern as presence.
export function handleStatusUpdate(event: CommunityStatusUpdate) {
  useCommunityWsStore.getState().setUserStatus(event.userId, event.statusEmoji, event.statusText)
}

// Push audit events into the bounded ring; the audit-log hook filters and
// prepends them into its React Query cache.
export function handleBotAuditEvent(event: CommunityBotAuditEvent) {
  useCommunityWsStore.getState().pushBotAuditEvent({
    id: event.id,
    botId: event.botId,
    kind: event.kind,
    payload: event.payload,
    sessionId: event.sessionId ?? null,
    launchId: event.launchId ?? null,
    createdAt: event.createdAt,
  })
}

export function handleMachineCreated(
  event: CommunityMachineCreated,
  { queryClient, cbs }: PresenceMachineEventContext,
) {
  queryClient.setQueryData<MachinesResponse | undefined>(
    communityKeys.machines(),
    (prev) => {
      if (!prev) return { machines: [event.machine] }
      const idx = prev.machines.findIndex((m) => m.id === event.machine.id)
      if (idx === -1) return { ...prev, machines: [event.machine, ...prev.machines] }
      const next = prev.machines.slice()
      next[idx] = event.machine
      return { ...prev, machines: next }
    },
  )
  useCommunityStore.getState().setPendingMachineTokenId(event.tokenId)
  cbs.onMachine?.(event)
}

export function handleMachineStatus(
  event: CommunityMachineStatus,
  { queryClient, cbs }: PresenceMachineEventContext,
) {
  queryClient.setQueryData<MachinesResponse | undefined>(
    communityKeys.machines(),
    (prev) =>
      prev
        ? {
          ...prev,
          machines: prev.machines.map((m) =>
            m.id === event.machineId
              ? { ...m, lastSeenAt: event.lastSeenAt, status: event.status }
              : m,
          ),
        }
        : prev,
  )
  cbs.onMachine?.(event)
}

export function handleMachineUpdated(
  event: CommunityMachineUpdated,
  { queryClient, cbs }: PresenceMachineEventContext,
) {
  queryClient.setQueryData<MachinesResponse | undefined>(
    communityKeys.machines(),
    (prev) => {
      if (!prev) return { machines: [event.machine] }
      const idx = prev.machines.findIndex((m) => m.id === event.machine.id)
      if (idx === -1) return { ...prev, machines: [event.machine, ...prev.machines] }
      const next: CommunityMachineSummary[] = prev.machines.slice()
      next[idx] = event.machine
      return { ...prev, machines: next }
    },
  )
  cbs.onMachine?.(event)
}

export function handleMachineRemoved(
  event: CommunityMachineRemoved,
  { queryClient, cbs }: PresenceMachineEventContext,
) {
  queryClient.setQueryData<MachinesResponse | undefined>(
    communityKeys.machines(),
    (prev) =>
      prev ? { ...prev, machines: prev.machines.filter((m) => m.id !== event.machineId) } : prev,
  )
  cbs.onMachine?.(event)
}
