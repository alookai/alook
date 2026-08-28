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
import type { FriendsPresenceResponse } from "@/hooks/community/use-friends"
import type { MachinesResponse } from "@/hooks/community/use-machines"
import type { PresenceMachineEventContext } from "@/hooks/community/community-ws/handler-context"

// The WS store carries the current server-member overlay. The friends snapshot
// is a second presence scope used by the DM shell and invite picker, so patch
// it too when it is mounted. Keeping exact deltas in both sources lets readers
// safely combine them without a stale online snapshot masking an offline event.
export function handlePresenceUpdate(
  event: CommunityPresenceUpdate,
  { queryClient }: PresenceMachineEventContext,
) {
  useCommunityWsStore.getState().setPresence(event.userId, event.online)
  queryClient.setQueryData<FriendsPresenceResponse | undefined>(
    communityKeys.friendsPresence(),
    (prev) => {
      if (!prev) return prev
      const currentlyOnline = prev.online.includes(event.userId)
      if (currentlyOnline === event.online) return prev
      return {
        ...prev,
        online: event.online
          ? [...prev.online, event.userId]
          : prev.online.filter((userId) => userId !== event.userId),
      }
    },
  )
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
  { queryClient }: PresenceMachineEventContext,
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
}

export function handleMachineStatus(
  event: CommunityMachineStatus,
  { queryClient }: PresenceMachineEventContext,
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
      if (idx === -1) return { ...prev, machines: [event.machine, ...prev.machines] }
      const next: CommunityMachineSummary[] = prev.machines.slice()
      next[idx] = event.machine
      return { ...prev, machines: next }
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
      prev ? { ...prev, machines: prev.machines.filter((m) => m.id !== event.machineId) } : prev,
  )
}
