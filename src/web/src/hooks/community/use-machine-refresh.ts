"use client"

import { useEffect, useMemo } from "react"
import { skipToken, useQuery, useQueryClient } from "@tanstack/react-query"
import { communityKeys } from "@/lib/query-keys"
import type { MachineRefreshState } from "@/lib/community/machine-refresh"
import { isAbortError } from "@/lib/errors"
import { useCommunityMutationOrigin } from "./community-origin"
import { useCommunityViewSource } from "./use-community-view-source"

const unconfirmedMessage = "Refresh could not be confirmed. Check this computer’s connection before trying again."
const dispatchErrors: Record<string, string> = {
  "machine is offline": "This machine is offline. Reconnect it before refreshing.",
  "machine not found": "This machine is no longer available. Reload the Machines page.",
  "update this daemon before remote Refresh is available": "Update this daemon before using Refresh.",
  "could not deliver the daemon refresh command": "Could not send the refresh request. Check the machine’s connection and try again.",
}

export function useMachineRefresh(machineId: string) {
  const queryClient = useQueryClient()
  const origin = useCommunityMutationOrigin()
  const source = useCommunityViewSource(`machine-refresh:${machineId}`)
  const queryKey = useMemo(() => communityKeys.machineRefresh(machineId), [machineId])
  const { data } = useQuery<MachineRefreshState>({ queryKey, queryFn: skipToken, gcTime: 300_000 })

  useEffect(() => {
    if (data?.status !== "pending") return
    const assert = source.capture()
    const timer = setTimeout(() => {
      try { assert() } catch { return }
      queryClient.setQueryData<MachineRefreshState>(queryKey, current => current?.requestId === data.requestId && current.status === "pending"
        ? { requestId: current.requestId, status: "unconfirmed", message: unconfirmedMessage } : current)
    }, Math.max(0, data.deadlineAt - Date.now()))
    return () => clearTimeout(timer)
  }, [data, queryClient, queryKey, source])

  async function refresh() {
    if (queryClient.getQueryData<MachineRefreshState>(queryKey)?.status === "pending") return
    const assert = source.capture()
    const { token } = origin.begin()
    assert()
    const requestId = crypto.randomUUID()
    queryClient.setQueryData<MachineRefreshState>(queryKey, (): MachineRefreshState => ({ requestId, status: "pending", phase: "sending", deadlineAt: Date.now() + 90_000 }))
    try {
      const response = await origin.request<{ dispatched: true; requestId: string }>(token, `/api/community/machines/${encodeURIComponent(machineId)}/refresh`, {
        method: "POST", body: JSON.stringify({ requestId }), signal: AbortSignal.any([assert.signal, AbortSignal.timeout(15_000)]), assertActive: assert,
      })
      assert()
      if (response.dispatched !== true || response.requestId !== requestId) throw new Error("Invalid refresh receipt")
      queryClient.setQueryData<MachineRefreshState>(queryKey, current => current?.requestId === requestId && current.status === "pending"
        ? { ...current, phase: "restarting" } : current)
    } catch (error) {
      try { assert() } catch { return }
      if (isAbortError(error)) return
      const message = error instanceof Error ? dispatchErrors[error.message] : undefined
      queryClient.setQueryData<MachineRefreshState>(queryKey, current => current?.requestId === requestId && current.status === "pending"
        ? { requestId, status: message ? "error" : "unconfirmed", message: message ?? unconfirmedMessage } : current)
    }
  }

  const feedback = data?.status === "pending"
    ? { status: "pending" as const, message: data.phase === "sending" ? "Sending refresh request…" : "Refresh requested. Waiting for the new daemon to connect…" }
    : data?.status === "complete"
      ? { status: "success" as const, message: "Refresh complete. The daemon reconnected with the latest shell environment." }
      : data ? { status: "error" as const, message: data.message } : undefined

  return { refresh, feedback, isPending: data?.status === "pending" }
}
