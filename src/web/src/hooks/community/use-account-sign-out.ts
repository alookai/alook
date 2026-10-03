"use client"

import { useCallback } from "react"
import { useMutation, useQueryClient, type MutateOptions } from "@tanstack/react-query"
import { signOutWithOrigin } from "@/lib/auth-client"
import { getCommunityDbRegistry } from "@/lib/community-db/collections"
import { captureCommunityLiveSnapshotToken, assertCommunityLiveSnapshotTokenCurrent } from "@/lib/community-db/sync"
import { retireCommunityAccount } from "@/lib/community/account-cache-lifecycle"

export function useAccountSignOut() {
  const queryClient = useQueryClient()
  const registry = getCommunityDbRegistry(queryClient)
  const capture = useCallback(() => {
    if (!registry) throw new DOMException("Missing sign-out account", "AbortError")
    if (getCommunityDbRegistry(queryClient) !== registry) throw new DOMException("Retired sign-out account", "AbortError")
    const token = captureCommunityLiveSnapshotToken(queryClient)
    assertCommunityLiveSnapshotTokenCurrent(queryClient, token, undefined)
    return { registry, token, authenticationGeneration: registry.authenticationView.get().generation }
  }, [queryClient, registry])
  const native = useMutation({ mutationKey: ["community", "sign-out"], scope: { id: "account-sign-out" }, gcTime: 0, mutationFn: async ({ registry, token }: ReturnType<typeof capture>) => {
    const assertActive = () => assertCommunityLiveSnapshotTokenCurrent(queryClient, token, undefined)
    assertActive()
    const generation = registry.authenticationView.get().generation
    const controller = new AbortController()
    const subscription = registry.runtime.lifecycle.subscribe(() => { try { assertActive() } catch { controller.abort() } })
    try {
      const result = await signOutWithOrigin(assertActive, { fetchOptions: { signal: controller.signal, onRequest: assertActive, onSuccess: assertActive } })
      if (result?.error) { assertActive(); throw new Error(result.error.message || "Failed to log out") }
      retireCommunityAccount(registry)
      await registry.retireDisk().catch((error: unknown) => {
        console.error("Account disk cache retirement failed", error)
      })
      const viewer = registry.sessionViewer()
      return registry.authenticationView.get().active && registry.authenticationView.get().generation === generation && (viewer === undefined || viewer === null || viewer === registry.accountId)
    } catch (error) { assertActive(); throw error }
    finally { subscription.unsubscribe() }
  } })
  const qualify = useCallback((options?: MutateOptions<boolean, Error, void, unknown>): MutateOptions<boolean, Error, ReturnType<typeof capture>, unknown> | undefined => {
    if (!options) return undefined
    const successCurrent = (intent: ReturnType<typeof capture>) => {
      const authentication = intent.registry.authenticationView.get(), viewer = intent.registry.sessionViewer()
      return getCommunityDbRegistry(queryClient) === intent.registry && authentication.active && authentication.generation === intent.authenticationGeneration && (viewer === undefined || viewer === null || viewer === intent.registry.accountId)
    }
    const errorCurrent = (intent: ReturnType<typeof capture>) => { try { assertCommunityLiveSnapshotTokenCurrent(queryClient, intent.token, undefined); return true } catch { return false } }
    return {
      onSuccess: (allowed, intent, result, context) => { if (allowed && successCurrent(intent)) options.onSuccess?.(allowed, undefined, result, context) },
      onError: (error, intent, result, context) => { if (errorCurrent(intent)) options.onError?.(error, undefined, result, context) },
      onSettled: (allowed, error, intent, result, context) => { if (error ? errorCurrent(intent) : allowed && successCurrent(intent)) options.onSettled?.(allowed, error, undefined, result, context) },
    }
  }, [queryClient])
  const nativeMutate = native.mutate, nativeMutateAsync = native.mutateAsync
  const mutate = useCallback((_?: void, options?: MutateOptions<boolean, Error, void, unknown>) => nativeMutate(capture(), qualify(options)), [nativeMutate, capture, qualify])
  const mutateAsync = useCallback((_?: void, options?: MutateOptions<boolean, Error, void, unknown>) => nativeMutateAsync(capture(), qualify(options)), [nativeMutateAsync, capture, qualify])
  return { ...native, mutate, mutateAsync }
}
