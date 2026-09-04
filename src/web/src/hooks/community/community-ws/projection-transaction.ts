import {
  hashKey,
  notifyManager,
  type InvalidateQueryFilters,
  type FetchQueryOptions,
  type QueryClient,
} from "@tanstack/react-query"

const projectionFlushErrors = new WeakMap<object, unknown>()

export function getCommunityWsProjectionFlushError(error: unknown) {
  if (
    error === null ||
    (typeof error !== "object" && typeof error !== "function")
  ) return undefined
  return projectionFlushErrors.get(error)
}

export type CommunityWsProjectionTransaction = {
  project: <T>(effect: () => T) => T
  invalidate: (owner: string, filters: InvalidateQueryFilters) => void
  fence: (owner: string, filters: InvalidateQueryFilters) => void
}

type PendingInvalidation = {
  filters: InvalidateQueryFilters
  cancellation?: Promise<void>
  replacementOptions?: FetchQueryOptions[]
}

function createProjectionTransaction(
  queryClient: QueryClient,
): CommunityWsProjectionTransaction & { flushInvalidations: () => void } {
  const pending = new Map<string, PendingInvalidation>()
  let flushed = false

  return {
    project: (effect) => effect(),
    invalidate: (owner, filters) => {
      if (flushed) throw new Error("community WS projection transaction already flushed")
      const identity = hashKey([owner, filters])
      if (!pending.has(identity)) pending.set(identity, { filters })
    },
    fence: (owner, filters) => {
      if (flushed) throw new Error("community WS projection transaction already flushed")
      const identity = hashKey([owner, filters])
      const current = pending.get(identity)
      if (current?.cancellation) return
      const replacementOptions = queryClient.getQueryCache().findAll(filters)
        .filter((query) => query.isActive() && query.options.queryFn)
        .map((query) => ({ ...query.options, staleTime: 0 } as FetchQueryOptions))
      const cancellation = queryClient.cancelQueries(filters)
      if (current) {
        current.cancellation = cancellation
        current.replacementOptions = replacementOptions
      } else {
        pending.set(identity, { filters, cancellation, replacementOptions })
      }
    },
    flushInvalidations: () => {
      if (flushed) return
      flushed = true
      for (const { filters, cancellation, replacementOptions } of pending.values()) {
        if (cancellation) {
          void cancellation.then(async () => {
            await queryClient.invalidateQueries({
              ...filters,
              refetchType: "none",
            })
            if (replacementOptions?.length) {
              await Promise.all(replacementOptions.map((options) => queryClient.fetchQuery(options)))
            } else {
              await queryClient.refetchQueries({
                ...filters,
                type: "active",
              })
            }
          })
        } else {
          void queryClient.invalidateQueries(filters)
        }
      }
    },
  }
}

export function runCommunityWsProjectionTransaction<T>(
  queryClient: QueryClient,
  project: (transaction: CommunityWsProjectionTransaction) => T,
): T {
  return notifyManager.batch(() => {
    const transaction = createProjectionTransaction(queryClient)
    let result: T | undefined
    let projectFailed = false
    let projectError: unknown
    let flushFailed = false
    let flushError: unknown

    try {
      result = project(transaction)
    } catch (error) {
      projectFailed = true
      projectError = error
    } finally {
      try {
        transaction.flushInvalidations()
      } catch (error) {
        flushFailed = true
        flushError = error
      }
    }

    if (projectFailed) {
      if (
        flushFailed &&
        projectError !== null &&
        (typeof projectError === "object" || typeof projectError === "function")
      ) {
        projectionFlushErrors.set(projectError, flushError)
      }
      throw projectError
    }
    if (flushFailed) throw flushError
    return result as T
  })
}
