"use client"

import { useNativeMutationFacade } from "@/hooks/use-native-mutation-facade"

import { useCallback } from "react"

import { useCommunityMutationOrigin } from "../community-origin"
import { useMutation, useQueryClient } from "@tanstack/react-query"

import { communityKeys } from "@/lib/query-keys"

export type CreateOrGetDmArgs = { userId: string; assertActive?: (() => void) & { signal: AbortSignal } }
export type CreateOrGetDmResult = { conversation: { id: string } }

/**
 * Open (or create) a DM conversation with a specific user. Returns the
 * conversation id. On success, invalidate the DM sidebar so a newly-created
 * DM appears there without a manual refetch.
 */
export function useCreateOrGetDm() {
  const origin = useCommunityMutationOrigin()
  const queryClient = useQueryClient()
  type Intent = CreateOrGetDmArgs & { original: ReturnType<typeof origin.begin>["token"] }
  const native = useMutation<CreateOrGetDmResult, Error, Intent>({ meta: { observabilityAction: "dm.open" },
    mutationFn: async ({ userId, original, assertActive }) => {
      // Unified create door (route/disc create-door step): POST /channels with
      // {type:"dm", userId} → get-or-create DM by peer identity.
      origin.assert(original); assertActive?.()
      const resources = queryClient.getQueryCache().findAll({ queryKey: communityKeys.dms() })
      const result = await origin.request<CreateOrGetDmResult>(original, "/api/community/channels", {
        method: "POST",
        body: JSON.stringify({ type: "dm", userId }),
        signal: assertActive?.signal,
        assertActive,
      })
      origin.assert(original)
      for (const resource of resources) if (queryClient.getQueryCache().find({ queryKey: resource.queryKey, exact: true }) === resource) await queryClient.invalidateQueries({ queryKey: resource.queryKey, exact: true }, { cancelRefetch: false })
      origin.assert(original)
      assertActive?.()
      return result
    },
  })
  const capture = useCallback((input: CreateOrGetDmArgs): Intent => { input.assertActive?.(); return { ...input, original: origin.begin().token } }, [origin])
  const assertCurrent = useCallback((args: Intent) => { origin.assert(args.original); args.assertActive?.() }, [origin])
  return useNativeMutationFacade(native, capture, assertCurrent)
}
