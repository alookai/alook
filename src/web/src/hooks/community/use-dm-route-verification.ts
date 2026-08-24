"use client"

import { useEffect } from "react"
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query"
import { communityKeys } from "@/lib/query-keys"
import type { DM } from "@/lib/community/models/people"
import { dmsQueryFn, type DmsResponse } from "./use-dms"

export type DmRouteVerification = "present" | "missing" | "denied"
export type DmRouteVerificationStatus = "idle" | "pending" | "present" | "missing"

export async function verifyDmRoute(
  queryClient: QueryClient,
  dmId: string,
): Promise<DmRouteVerification> {
  try {
    const response = await queryClient.fetchQuery<DmsResponse>({
      queryKey: communityKeys.dms(),
      queryFn: dmsQueryFn,
      staleTime: 0,
    })
    return response.conversations.some((dm) => dm.id === dmId) ? "present" : "missing"
  } catch (error) {
    const status = typeof error === "object" && error !== null && "status" in error
      ? error.status
      : undefined
    if (status === 403 || status === 404) {
      return "denied"
    }
    throw error
  }
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
  return queryClient.fetchQuery({
    ...verificationOptions(queryClient, dmId),
    staleTime: 0,
  })
}

export function useDmRouteVerification(
  dmId: string | undefined,
  dms: readonly DM[],
): DmRouteVerificationStatus {
  const queryClient = useQueryClient()
  const present = !!dmId && dms.some((dm) => dm.id === dmId)
  const verification = useQuery({
    ...verificationOptions(queryClient, dmId ?? "__none__"),
    enabled: !!dmId && !present,
    staleTime: Infinity,
  })
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

  if (!dmId) return "idle"
  if (verification.data === "missing" || verification.data === "denied") return "missing"
  if (present || verification.data === "present") return "present"
  if (verification.fetchStatus === "fetching") return "pending"
  return "pending"
}
