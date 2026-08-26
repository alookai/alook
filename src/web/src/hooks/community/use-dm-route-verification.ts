"use client"

import { useCallback, useEffect } from "react"
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api/client"
import { communityKeys } from "@/lib/query-keys"
import type { DM } from "@/lib/community/models/people"
import type { DmsResponse } from "./use-dms"

export const DM_ROUTE_AUTHORITY_HEADER = "X-Alook-DM-Route-Verification"

const dmRouteAuthorityQueryFn = () => apiFetch<DmsResponse>(
  "/api/community/users/me/dms",
  { headers: { [DM_ROUTE_AUTHORITY_HEADER]: "1" } },
)

export type DmRouteVerification = "present" | "missing" | "denied"
export type DmRouteVerificationStatus = "idle" | "pending" | "present" | "missing" | "error"
export type DmRouteVerificationResult = {
  status: DmRouteVerificationStatus
  retry: () => void
  retrying: boolean
}

export function classifyDmRouteAuthorityError(error: unknown): "denied" | "error" {
  const status = typeof error === "object" && error !== null && "status" in error
    ? error.status
    : undefined
  return status === 403 || status === 404 ? "denied" : "error"
}

function verifyDmRoute(
  queryClient: QueryClient,
  dmId: string,
): Promise<DmRouteVerification> {
  return dmRouteAuthorityQueryFn().then(
    (response) => {
      queryClient.setQueryData(communityKeys.dms(), response)
      return response.conversations.some((dm) => dm.id === dmId) ? "present" : "missing"
    },
    (error: unknown) => {
      if (classifyDmRouteAuthorityError(error) === "denied") return "denied"
      throw error
    },
  )
}

function verificationOptions(queryClient: QueryClient, dmId: string) {
  return {
    queryKey: communityKeys.dmRouteVerification(dmId),
    queryFn: () => verifyDmRoute(queryClient, dmId),
    retry: false,
  } as const
}

export function startDmRouteVerification(
  queryClient: QueryClient,
  dmId: string,
): Promise<DmRouteVerification> {
  const canonical = queryClient.getQueryData<DmsResponse>(communityKeys.dms())
  if (canonical?.conversations.some((dm) => dm.id === dmId)) {
    return Promise.resolve("present")
  }
  return queryClient.fetchQuery({
    ...verificationOptions(queryClient, dmId),
    staleTime: 0,
  })
}

export function useDmRouteVerification(
  dmId: string | undefined,
  dms: readonly DM[],
  canonicalUnsettled: boolean,
): DmRouteVerificationResult {
  const queryClient = useQueryClient()
  const present = !!dmId && dms.some((dm) => dm.id === dmId)
  const verification = useQuery({
    ...verificationOptions(queryClient, dmId ?? "__none__"),
    enabled: !!dmId && !canonicalUnsettled && !present,
    staleTime: Infinity,
  })
  const retry = useCallback(() => {
    if (!dmId || verification.fetchStatus === "fetching") return
    void verification.refetch()
  }, [dmId, verification])
  useEffect(() => {
    if (!dmId) return
    return () => {
      const queryKey = communityKeys.dmRouteVerification(dmId)
      queueMicrotask(() => {
        const query = queryClient.getQueryCache().find({ queryKey, exact: true })
        if (query?.getObserversCount() !== 0) return
        queryClient.removeQueries({ queryKey, exact: true })
      })
    }
  }, [dmId, queryClient])

  let status: DmRouteVerificationStatus = "pending"
  if (!dmId) status = "idle"
  else if (present || verification.data === "present") status = "present"
  else if (verification.data === "missing" || verification.data === "denied") status = "missing"
  else if (verification.isError) status = "error"

  return {
    status,
    retry,
    retrying: verification.fetchStatus === "fetching",
  }
}
