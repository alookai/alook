"use client"

import { useCallback } from "react"
import { useCreateAtom, useAtom } from "@tanstack/react-store"
import { hashKey, type QueryKey, type UseQueryResult } from "@tanstack/react-query"
import { isConversationAccessError } from "@/lib/community/conversation-read"

export function useConversationReadRetry<T>(
  query: Pick<UseQueryResult<T>, "isError" | "isFetching" | "refetch"> & Partial<Pick<UseQueryResult<T>, "error">>,
  owner: object,
  scope: QueryKey,
) {
  const identity = hashKey(scope)
  const state = useCreateAtom<{ owner: object; identity: string; pending: Promise<void> } | null>(null)
  const [operation] = useAtom(state)
  const retrying = operation?.owner === owner && operation.identity === identity
  const { isError, isFetching, error, refetch } = query
  const retry = useCallback(() => {
    const active = state.get()
    if (active?.owner === owner && active.identity === identity) return Promise.resolve()
    if (!isError || isFetching || isConversationAccessError(error)) return Promise.resolve()
    const pending = refetch({ cancelRefetch: false }).then(() => {}).finally(() => state.set((current) => current?.pending === pending ? null : current))
    state.set({ owner, identity, pending })
    return pending
  }, [isError, isFetching, error, refetch, state, owner, identity])
  return { retry, retrying, failed: isError || retrying }
}
