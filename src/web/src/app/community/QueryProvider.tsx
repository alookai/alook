"use client"

import { useState, type ReactNode } from "react"
import { ReactQueryDevtools } from "@tanstack/react-query-devtools"
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client"
import { createQueryClient } from "@/lib/query-client"
import {
  createIdbPersister,
  PERSIST_BUSTER,
  PERSIST_MAX_AGE_MS,
  shouldPersistQuery,
} from "@/lib/query-persister"

/**
 * Owns the TanStack QueryClient for the community subtree.
 *
 * The client is held in `useState(() => createQueryClient())` so React
 * strict-mode double-invoke in dev doesn't discard queries between mounts and
 * so each SSR request gets its own instance rather than sharing a
 * module-scoped singleton across users. Coexists with `<CommunityProvider>`
 * during the God-context migration — later steps move state into TanStack
 * Query and Zustand, then delete the old provider.
 *
 * `userId` scopes the IndexedDB namespace so account switches never surface
 * the previous session's cached message list. Passing `null` (pre-auth) hits
 * an "anon" namespace that never carries real content.
 */
export function QueryProvider({
  children,
  userId,
}: {
  children: ReactNode
  userId: string | null
}) {
  const [queryClient] = useState(() => createQueryClient())
  // Persister is bound to the userId at construction; on account switch the
  // whole community subtree unmounts and the shell re-renders with the new
  // id, so we don't need to reactively rebuild the persister mid-session.
  const [persister] = useState(() => createIdbPersister(userId))
  const isDev = process.env.NODE_ENV !== "production"

  return (
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={{
        persister,
        maxAge: PERSIST_MAX_AGE_MS,
        buster: PERSIST_BUSTER,
        dehydrateOptions: {
          shouldDehydrateQuery: (query) => {
            // Two-stage filter:
            // 1. Key must be in the persisted allowlist (only message queries
            //    are persisted — presence/servers/etc. refetch on mount).
            // 2. For message queries, `pages[0]` must be a trusted
            //    newest-tail shape. A since-mode or older-only envelope has
            //    no `hasMore` flag on page 0 → the next mount reads
            //    `hasMoreOlder ?? hasMore ?? false` as false and silently
            //    loses history. Filter these out at write time so the
            //    self-healing invariant holds across sessions.
            if (query.state.status !== "success") return false
            return shouldPersistQuery(query.queryKey, query.state.data)
          },
        },
      }}
    >
      {children}
      {isDev ? <ReactQueryDevtools initialIsOpen={false} /> : null}
    </PersistQueryClientProvider>
  )
}
