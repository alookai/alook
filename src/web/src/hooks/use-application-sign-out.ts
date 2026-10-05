"use client"

import { useCallback } from "react"
import { useMutation, type MutateOptions } from "@tanstack/react-query"
import { signOutWithOrigin } from "@/lib/auth-client"
import { applicationKey, assertApplicationOwner, captureApplicationOwner, retireApplicationOwner, useApplicationOwner } from "@/lib/application-owner"

export function useApplicationSignOut() {
  const owner = useApplicationOwner()
  const native = useMutation({ meta: { observabilityAction: "account.sign_out" }, mutationKey: applicationKey(owner, "sign-out"), scope: { id: "account-sign-out" }, gcTime: 0, mutationFn: async (token: ReturnType<typeof captureApplicationOwner>) => {
    assertApplicationOwner(token)
    const controller = new AbortController()
    const subscription = owner.lifecycle.subscribe(() => {
      try { assertApplicationOwner(token) } catch { controller.abort() }
    })
    try {
      const result = await signOutWithOrigin(() => assertApplicationOwner(token), { fetchOptions: { signal: controller.signal, onRequest: () => assertApplicationOwner(token), onSuccess: () => assertApplicationOwner(token) } })
      if (result?.error) { assertApplicationOwner(token); throw new Error(result.error.message || "Failed to log out") }
      if (owner.lifecycle.get().active && owner.lifecycle.get().generation === token.generation) retireApplicationOwner(owner)
      owner.queryClient.clear()
      await owner.retireDisk().catch((error: unknown) => {
        console.error("Application disk cache retirement failed", error)
      })
      const state = owner.lifecycle.get(), viewer = owner.sessionViewer()
      return !state.active && state.generation === token.generation + 1 && (viewer === undefined || viewer === null || viewer === owner.userId)
    } catch (error) {
      assertApplicationOwner(token)
      throw error
    } finally { subscription.unsubscribe() }
  } })
  const capture = useCallback(() => { const token = captureApplicationOwner(owner); assertApplicationOwner(token); return token }, [owner])
  const qualify = useCallback((options?: MutateOptions<boolean, Error, void, unknown>): MutateOptions<boolean, Error, ReturnType<typeof captureApplicationOwner>, unknown> | undefined => {
    if (!options) return undefined
    const successCurrent = (token: ReturnType<typeof captureApplicationOwner>) => {
      const state = token.owner.lifecycle.get(), viewer = token.owner.sessionViewer()
      return !state.active && state.generation === token.generation + 1 && (viewer === undefined || viewer === null || viewer === token.owner.userId)
    }
    const errorCurrent = (token: ReturnType<typeof captureApplicationOwner>) => { try { assertApplicationOwner(token); return true } catch { return false } }
    return {
      onSuccess: (allowed, token, result, context) => { if (allowed && successCurrent(token)) options.onSuccess?.(allowed, undefined, result, context) },
      onError: (error, token, result, context) => { if (errorCurrent(token)) options.onError?.(error, undefined, result, context) },
      onSettled: (allowed, error, token, result, context) => { if (error ? errorCurrent(token) : allowed && successCurrent(token)) options.onSettled?.(allowed, error, undefined, result, context) },
    }
  }, [])
  const nativeMutate = native.mutate, nativeMutateAsync = native.mutateAsync
  const mutate = useCallback((_?: void, options?: MutateOptions<boolean, Error, void, unknown>) => nativeMutate(capture(), qualify(options)), [nativeMutate, capture, qualify])
  const mutateAsync = useCallback((_?: void, options?: MutateOptions<boolean, Error, void, unknown>) => nativeMutateAsync(capture(), qualify(options)), [nativeMutateAsync, capture, qualify])
  return { ...native, mutate, mutateAsync }
}
