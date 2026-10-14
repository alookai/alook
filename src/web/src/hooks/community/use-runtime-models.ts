"use client"

import { useCallback, useEffect, useMemo, useRef } from "react"
import { skipToken, useQuery, useQueryClient } from "@tanstack/react-query"
import type { RuntimeModelDiscoveryResult } from "@alook/shared"
import { communityKeys } from "@/lib/query-keys"
import { isAbortError } from "@/lib/errors"
import { useCommunityWsStore } from "@/stores/community/ws"
import { useCommunityMutationOrigin } from "./community-origin"

export type RuntimeModelsState = { requestId: string } & (
  | { status: "pending" | "cancelled" }
  | RuntimeModelDiscoveryResult
)

export function useRuntimeModels(machineId: string, runtimeId: string) {
  const queryClient = useQueryClient()
  const origin = useCommunityMutationOrigin()
  const ownedRequest = useRef<string | null>(null)
  const connectionStatus = useCommunityWsStore((state) => state.connectionStatus)
  const queryKey = useMemo(() => communityKeys.runtimeModels(machineId, runtimeId), [machineId, runtimeId])
  const { data } = useQuery<RuntimeModelsState>({ queryKey, queryFn: skipToken, gcTime: 60_000 })

  const finishError = useCallback((requestId: string, message: string) => {
    queryClient.setQueryData<RuntimeModelsState>(queryKey, (current) =>
      current?.requestId === requestId && current.status === "pending"
        ? { requestId, status: "error", code: "DISCOVERY_FAILED", message }
        : current,
    )
  }, [queryClient, queryKey])

  const cancel = useCallback(() => {
    queryClient.setQueryData<RuntimeModelsState>(queryKey, (current) =>
      current?.status === "pending" && current.requestId === ownedRequest.current
        ? { requestId: current.requestId, status: "cancelled" } : current,
    )
    ownedRequest.current = null
  }, [queryClient, queryKey])

  function discover() {
    if (queryClient.getQueryData<RuntimeModelsState>(queryKey)?.status === "pending") return
    const requestId = crypto.randomUUID()
    ownedRequest.current = requestId
    queryClient.setQueryData<RuntimeModelsState>(queryKey, { requestId, status: "pending" })
    if (connectionStatus !== "connected") {
      finishError(requestId, "Reconnect to load models.")
      return
    }
    const { token } = origin.begin()
    void origin.request(token, `/api/community/machines/${encodeURIComponent(machineId)}/discover-models`, {
      method: "POST", body: JSON.stringify({ requestId, runtimeId }),
    }).catch((error: unknown) => {
      if (isAbortError(error)) return
      const message = error instanceof Error ? error.message : "Could not load models."
      finishError(requestId, message === "UPGRADE_REQUIRED" ? "Update this machine’s daemon to load models."
        : message === "MACHINE_OFFLINE" ? "This machine is offline." : message)
    })
  }

  useEffect(() => {
    if (data?.status !== "pending") return
    if (connectionStatus !== "connected") {
      finishError(data.requestId, "Connection lost. Retry to load models.")
      return
    }
    const timer = setTimeout(() => finishError(data.requestId, "Model discovery timed out. Retry to load models."), 45_000)
    return () => clearTimeout(timer)
  }, [data?.requestId, data?.status, connectionStatus, finishError])

  useEffect(() => cancel, [cancel])

  return {
    isPending: data?.status === "pending",
    error: data?.status === "error" ? data.message : null,
    onOpenChange: (open: boolean) => open ? discover() : cancel(),
    retry: discover,
  }
}
