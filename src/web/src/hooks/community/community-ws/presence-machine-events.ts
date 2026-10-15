import { appendBotAuditEvent, type AuditEvent } from "@/hooks/community/use-bot-audit-log"
import { getCommunityRuntime } from "@/stores/community/runtime"
import { replaceMachines, type MachinesResponse } from "@/hooks/community/use-machines"
import { captureMachinesPublication, publishMachines } from "@/lib/community/machines"
import { assertCommunityLiveSnapshotTokenCurrent } from "@/lib/community-db/sync"
import type {
  CommunityBotAuditEvent,
  CommunityMachineCreated,
  CommunityMachineRemoved,
  CommunityMachineStatus,
  CommunityMachineUpdated,
  CommunityPresenceUpdate,
  CommunityWsEvent,
  CommunityStatusUpdate,
} from "@alook/shared"
import { communityKeys } from "@/lib/query-keys"


import type { RuntimeModelsState } from "@/hooks/community/use-runtime-models"
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

export async function handleMachineCreated(
  event: CommunityMachineCreated,
  { queryClient }: PresenceMachineEventContext,
) {
  const original = captureMachinesPublication(queryClient)
  const published = await publishMachines(queryClient, original,
    (prev) => {
      if (!prev) return { machines: [event.machine], complete: false }
      const idx = prev.machines.findIndex((m) => m.id === event.machine.id)
      if (idx === -1) return replaceMachines(prev, [event.machine, ...prev.machines])
      const next = prev.machines.slice()
      next[idx] = event.machine
      return replaceMachines(prev, next)
    },
  )
  if (!published) return
  assertCommunityLiveSnapshotTokenCurrent(queryClient, original.token, undefined)
  if (queryClient.getQueryCache().get(original.query.queryHash) !== original.query) return
  getCommunityRuntime(queryClient).ui.actions.setPendingMachineTokenId(event.tokenId)
  const current = queryClient.getQueryData<MachinesResponse>(original.query.queryKey)
  if (current?.complete === false || current?.observed === false) void queryClient.invalidateQueries({ queryKey: communityKeys.machines(), exact: true })
}

export async function handleMachineStatus(
  event: CommunityMachineStatus,
  { queryClient }: PresenceMachineEventContext,
) {
  await publishMachines(queryClient, captureMachinesPublication(queryClient),
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

export async function handleMachineUpdated(
  event: CommunityMachineUpdated,
  { queryClient }: PresenceMachineEventContext,
) {
  const original = captureMachinesPublication(queryClient)
  const published = await publishMachines(queryClient, original,
    (prev) => {
      if (!prev) return { machines: [event.machine], complete: false }
      const idx = prev.machines.findIndex((m) => m.id === event.machine.id)
      if (idx === -1) return replaceMachines(prev, [event.machine, ...prev.machines])
      const next: MachinesResponse["machines"] = prev.machines.slice()
      next[idx] = event.machine
      return replaceMachines(prev, next)
    },
  )
  if (!published) return
  assertCommunityLiveSnapshotTokenCurrent(queryClient, original.token, undefined)
  if (queryClient.getQueryCache().get(original.query.queryHash) !== original.query) return
  const current = queryClient.getQueryData<MachinesResponse>(original.query.queryKey)
  if (current?.complete === false || current?.observed === false) void queryClient.invalidateQueries({ queryKey: communityKeys.machines(), exact: true })
}

export async function handleMachineRemoved(
  event: CommunityMachineRemoved,
  { queryClient }: PresenceMachineEventContext,
) {
  await publishMachines(queryClient, captureMachinesPublication(queryClient),
    (prev) =>
      prev ? replaceMachines(prev, prev.machines.filter((m) => m.id !== event.machineId)) : prev,
  )
}

export async function handleRuntimeModels(event: Extract<CommunityWsEvent, { type: "community:runtime.models" }>, { queryClient }: PresenceMachineEventContext) {
  const key = communityKeys.runtimeModels(event.machineId, event.runtimeId)
  const pending = queryClient.getQueryData<RuntimeModelsState>(key)
  if (pending?.status !== "pending" || pending.requestId !== event.requestId) return
  queryClient.setQueryData<RuntimeModelsState>(key, { requestId: event.requestId, ...event.result })
  if (event.result.status !== "complete") return
  const catalog = event.result.catalog
  await publishMachines(queryClient, captureMachinesPublication(queryClient), (previous) => previous
    ? replaceMachines(previous, previous.machines.map((machine) => machine.id === event.machineId
      ? { ...machine, availableRuntimes: machine.availableRuntimes?.map((runtime) => {
          if (typeof runtime === "string" || runtime.id !== event.runtimeId) return runtime
          const { reasoning: _previousCatalog, ...rest } = runtime
          return catalog ? { ...rest, reasoning: catalog } : rest
        }) }
      : machine))
    : previous,
  )
}
