"use client"

import { useCallback } from "react"
import type { MutateOptions, UseMutationResult } from "@tanstack/react-query"

export function useNativeMutationFacade<Data, Error, Input, Intent, Context>(
  native: UseMutationResult<Data, Error, Intent, Context>,
  capture: (input: Input) => Intent,
  assertCurrent: (intent: Intent) => void,
) {
  const qualify = useCallback((input: Input, callbacks?: MutateOptions<Data, Error, Input, Context>): MutateOptions<Data, Error, Intent, Context> | undefined => callbacks && ({
    onSuccess: (data, intent, result, context) => { try { assertCurrent(intent) } catch { return } callbacks.onSuccess?.(data, input, result, context) },
    onError: (error, intent, result, context) => { try { assertCurrent(intent) } catch { return } callbacks.onError?.(error, input, result, context) },
    onSettled: (data, error, intent, result, context) => { try { assertCurrent(intent) } catch { return } callbacks.onSettled?.(data, error, input, result, context) },
  }), [assertCurrent])
  const nativeMutate = native.mutate, nativeMutateAsync = native.mutateAsync
  const mutate = useCallback((input: Input, callbacks?: MutateOptions<Data, Error, Input, Context>) => nativeMutate(capture(input), qualify(input, callbacks)), [nativeMutate, capture, qualify])
  const mutateAsync = useCallback((input: Input, callbacks?: MutateOptions<Data, Error, Input, Context>) => nativeMutateAsync(capture(input), qualify(input, callbacks)), [nativeMutateAsync, capture, qualify])
  return { ...native, mutate, mutateAsync }
}
