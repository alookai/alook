import { QueryClient } from "@tanstack/react-query"
import { PERSIST_MAX_AGE_MS } from "@/lib/query-persister"

/**
 * Factory for a QueryClient with app defaults.
 *
 * Exported as a factory (not a singleton) so the provider component can hold
 * the instance in `useState(() => createQueryClient())`. That keeps queries
 * from being reset by React strict-mode double-invocation in dev, keeps SSR
 * safe (no module-scoped client shared across requests), and gives tests a
 * fresh client per render.
 *
 * `gcTime` matches the persister's `maxAge` so TanStack doesn't garbage-collect
 * inactive queries before the persister has a chance to write them out — the
 * TanStack docs are explicit that `gcTime >= maxAge` or restore returns empty
 * caches for anything the user hasn't touched in the current session.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 5_000,
        gcTime: PERSIST_MAX_AGE_MS,
        refetchOnWindowFocus: false,
        retry: 1,
      },
    },
  })
}
