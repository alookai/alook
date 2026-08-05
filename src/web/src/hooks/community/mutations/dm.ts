"use client"

import { useMutation, useQueryClient } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api/client"
import { communityKeys } from "@/lib/query-keys"

export type CreateOrGetDmArgs = { userId: string }
export type CreateOrGetDmResult = { conversation: { id: string } }

/**
 * Open (or create) a DM conversation with a specific user. Returns the
 * conversation id. On success, invalidate the DM sidebar so a newly-created
 * DM appears there without a manual refetch.
 */
export function useCreateOrGetDm() {
  const queryClient = useQueryClient()
  return useMutation<CreateOrGetDmResult, Error, CreateOrGetDmArgs>({
    mutationFn: async ({ userId }) => {
      // Unified create door (route/disc create-door step): POST /channels with
      // {type:"dm", userId} → get-or-create DM by peer identity.
      return apiFetch<CreateOrGetDmResult>("/api/community/channels", {
        method: "POST",
        body: JSON.stringify({ type: "dm", userId }),
      })
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: communityKeys.dms() })
    },
  })
}
