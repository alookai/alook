"use client"

import { useCallback, useEffect, useMemo, useRef } from "react"
import { skipToken, useQuery, useQueryClient } from "@tanstack/react-query"
import { RuntimeModelDiscoveryResultSchema, type RuntimeModelDiscoveryResult } from "@alook/shared"
import { communityKeys } from "@/lib/query-keys"
import { isAbortError } from "@/lib/errors"
import { handleRuntimeModels } from "./community-ws/presence-machine-events"
import { useCommunityMutationOrigin } from "./community-origin"

export type RuntimeModelsState = { requestId: string; transport?: "http" } & (
  | { status: "pending" | "cancelled" }
  | RuntimeModelDiscoveryResult
)

export function useRuntimeModels(machineId: string, runtimeId: string) {
  const queryClient = useQueryClient()
  const origin = useCommunityMutationOrigin()
  const ownedRequest = useRef<string | null>(null)
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

  function discover(refresh = false) {
    if (queryClient.getQueryData<RuntimeModelsState>(queryKey)?.status === "pending") return
    const requestId = crypto.randomUUID()
    ownedRequest.current = requestId
    queryClient.setQueryData<RuntimeModelsState>(queryKey, { requestId, status: "pending", transport: "http" })
    const { token } = origin.begin()
    void origin.request<{ requestId: string; machineId: string; backendId: string; source: string; observedAt: string; result: unknown }>(token, `/api/community/machines/${encodeURIComponent(machineId)}/discover-models?wait=1`, {
      method: "POST", body: JSON.stringify({ requestId, runtimeId, ...(refresh ? { refresh: true } : {}) }), signal: AbortSignal.timeout(55_000),
    }).then(async (response) => {
      origin.assert(token)
      const result = RuntimeModelDiscoveryResultSchema.safeParse(response.result)
      if (response.requestId !== requestId || response.machineId !== machineId || response.backendId !== runtimeId || !result.success
        || !["cached_report", "fresh_discovery"].includes(response.source) || !Number.isFinite(Date.parse(response.observedAt))) throw new Error("Could not load models.")
      await handleRuntimeModels({ type: "community:runtime.models", requestId, machineId, runtimeId, result: result.data }, { queryClient }, "http")
    }).catch((error: unknown) => {
      if (isAbortError(error)) return
      const message = typeof error === "object" && error !== null && "name" in error && error.name === "TimeoutError" ? "Model discovery timed out. Retry to load models."
        : error instanceof Error ? error.message : "Could not load models."
      finishError(requestId, message === "UPGRADE_REQUIRED" ? "Update this machine’s daemon to load models."
        : message === "MACHINE_OFFLINE" ? "This machine is offline." : message)
    })
  }

  useEffect(() => cancel, [cancel])

  return {
    isPending: data?.status === "pending",
    error: data?.status === "error" ? data.message : null,
    onOpenChange: (open: boolean) => open ? discover() : cancel(),
    retry: () => discover(true),
  }
}
