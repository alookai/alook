import {
  hashKey,
  notifyManager,
  type InvalidateQueryFilters,
  type QueryExecuteOptions,
  type QueryClient,
  type Query,
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
  fence: (owner: string, filters: InvalidateQueryFilters, isCurrent?: () => boolean) => void
}

type PendingInvalidation = {
  filters: InvalidateQueryFilters
  cancellation?: Promise<void>
  originalQueries?: ReadonlySet<Query>
  replacements?: Array<{ query: Query; options: QueryExecuteOptions }>
  isCurrent?: () => boolean
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
    fence: (owner, filters, isCurrent) => {
      if (flushed) throw new Error("community WS projection transaction already flushed")
      const identity = hashKey([owner, filters])
      const current = pending.get(identity)
      if (current?.cancellation) {
        current.isCurrent = isCurrent
        return
      }
      const queries = queryClient.getQueryCache().findAll(filters)
      const originalQueries = new Set(queries)
      const replacements = queries
        .filter((query) => query.isActive() && query.options.queryFn)
        .map((query) => ({ query, options: { ...query.options, staleTime: 0 } as QueryExecuteOptions }))
      const cancellation = queryClient.cancelQueries(filters)
      if (current) {
        current.cancellation = cancellation
        current.originalQueries = originalQueries
        current.replacements = replacements
        current.isCurrent = isCurrent
      } else {
        pending.set(identity, { filters, cancellation, originalQueries, replacements, isCurrent })
      }
    },
    flushInvalidations: () => {
      if (flushed) return
      flushed = true
      for (const { filters, cancellation, originalQueries, replacements, isCurrent } of pending.values()) {
        if (cancellation) {
          void cancellation.then(async () => {
            if (isCurrent && !isCurrent()) return
            const registered = new Set([...(originalQueries ?? [])].filter((query) => (
              queryClient.getQueryCache().get(query.queryHash) === query
            )))
            await queryClient.invalidateQueries({
              ...filters,
              predicate: (query) => registered.has(query) && (!filters.predicate || filters.predicate(query)),
              refetchType: "none",
            })
            if (isCurrent && !isCurrent()) return
            await Promise.all((replacements ?? [])
              .filter(({ query }) => queryClient.getQueryCache().get(query.queryHash) === query && query.isActive())
              .map(({ options }) => queryClient.query({ ...options, select: undefined })))
          }).catch(() => {})
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
