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
      return apiFetch<CreateOrGetDmResult>("/api/community/dm", {
        method: "POST",
        body: JSON.stringify({ userId }),
      })
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: communityKeys.dms() })
    },
  })
}
