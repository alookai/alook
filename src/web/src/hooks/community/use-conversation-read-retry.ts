"use client"

import { useCallback, useMemo } from "react"
import { createStore, useSelector } from "@tanstack/react-store"
import { hashKey, type QueryKey, type UseQueryResult } from "@tanstack/react-query"
import { isConversationAccessError } from "@/lib/community/conversation-read"

export function useConversationReadRetry<T>(
  query: Pick<UseQueryResult<T>, "isError" | "isFetching" | "refetch"> & Partial<Pick<UseQueryResult<T>, "error">>,
  owner: object,
  scope: QueryKey,
) {
  const identity = hashKey(scope)
  const state = useMemo(() => createStore({ operation: null as Promise<void> | null }), [owner, identity])
  const operation = useSelector(state, (value) => value.operation)
  const retry = useCallback(() => {
    if (state.get().operation) return Promise.resolve()
    if (!query.isError || query.isFetching || isConversationAccessError(query.error)) return Promise.resolve()
    const pending = query.refetch({ cancelRefetch: false }).then(() => {}).finally(() => state.setState(() => ({ operation: null })))
    state.setState(() => ({ operation: pending }))
    return pending
  }, [query.isError, query.isFetching, query.error, query.refetch, state])
  return { retry, retrying: !!operation, failed: query.isError || !!operation }
}
