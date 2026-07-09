import { QueryClient } from "@tanstack/react-query"

/**
 * Factory for a QueryClient with app defaults.
 *
 * Exported as a factory (not a singleton) so the provider component can hold
 * the instance in `useState(() => createQueryClient())`. That keeps queries
 * from being reset by React strict-mode double-invocation in dev, keeps SSR
 * safe (no module-scoped client shared across requests), and gives tests a
 * fresh client per render.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 5_000,
        refetchOnWindowFocus: false,
        retry: 1,
      },
    },
  })
}
