"use client"

import { useMutation, type Query, type UseMutationOptions } from "@tanstack/react-query"
import { useCallback } from "react"
import { useNativeMutationFacade } from "@/hooks/use-native-mutation-facade"
import type { useCommunityMutationOrigin } from "./community-origin"

type Origin = ReturnType<typeof useCommunityMutationOrigin>
export type CommunityCommandArgs<Input> = Input & { original: ReturnType<Origin["begin"]>["token"]; resources: Query[] }

export function communityCommandInput<Input extends object>({ original: _original, resources: _resources, ...input }: CommunityCommandArgs<Input>): Input {
  return input as Input
}

export function useCommunityCommandMutation<Data = unknown, Error = globalThis.Error, Input extends object = object, Result = unknown>(origin: Origin, options: UseMutationOptions<Data, Error, CommunityCommandArgs<Input>, Result>, assertSuccess?: (args: CommunityCommandArgs<Input>) => void) {
  const native = useMutation<Data, Error, CommunityCommandArgs<Input>, Result>({ meta: { observabilityAction: "community.command" }, gcTime: 0, ...options,
    onSuccess: async (data, args, result, context) => { try { origin.assert(args.original) } catch { return } await options.onSuccess?.(data, args, result, context) },
    onError: async (error, args, result, context) => { try { origin.assert(args.original) } catch { return } await options.onError?.(error, args, result, context) },
    onSettled: async (data, error, args, result, context) => { try { origin.assert(args.original) } catch { return } await options.onSettled?.(data, error, args, result, context) },
  })
  const capture = useCallback((input: Input): CommunityCommandArgs<Input> => {
    const original = origin.begin().token
    origin.assert(original)
    return { ...input, original, resources: origin.registry!.queryClient.getQueryCache().findAll() }
  }, [origin])
  const assertCurrent = useCallback((args: CommunityCommandArgs<Input>) => origin.assert(args.original), [origin])
  return useNativeMutationFacade(native, capture, assertCurrent, { projectInput: communityCommandInput<Input>, assertSuccess })
}
