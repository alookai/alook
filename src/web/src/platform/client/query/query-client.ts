import { QueryClient } from "@tanstack/react-query"

type CreateQueryClientOptions = Readonly<{
  persistedCacheMaxAgeMs: number
}>

/**
 * Factory for a QueryClient with app defaults.
 *
 * Exported as a factory (not a singleton) so a product provider can hold the
 * instance in lazy React state. That keeps queries
 * from being reset by React strict-mode double-invocation in dev, keeps SSR
 * safe (no module-scoped client shared across requests), and gives tests a
 * fresh client per render.
 *
 * The caller supplies the persisted cache max age so `gcTime` matches its
 * product persistence policy without platform code importing that policy.
 * TanStack must not garbage-collect
 * inactive queries before the persister has a chance to write them out — the
 * TanStack docs are explicit that `gcTime >= maxAge` or restore returns empty
 * caches for anything the user hasn't touched in the current session.
 */
export function createQueryClient({
  persistedCacheMaxAgeMs,
}: CreateQueryClientOptions): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 5_000,
        gcTime: persistedCacheMaxAgeMs,
        refetchOnWindowFocus: false,
        retry: 1,
      },
    },
  })
}
