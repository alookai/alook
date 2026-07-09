"use client"

import { useState, type ReactNode } from "react"
import { ReactQueryDevtools } from "@tanstack/react-query-devtools"
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client"
import { createQueryClient } from "@/lib/query-client"
import {
  createIdbPersister,
  PERSIST_BUSTER,
  PERSIST_MAX_AGE_MS,
  shouldPersistQueryKey,
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
            // Only persist message queries + read-state snapshots. Everything
            // else (presence, live server list, DM list, member roster) is
            // cheap to refetch on mount and would introduce staleness hazards
            // if it survived a page load.
            if (query.state.status !== "success") return false
            return shouldPersistQueryKey(query.queryKey)
          },
        },
      }}
    >
      {children}
      {isDev ? <ReactQueryDevtools initialIsOpen={false} /> : null}
    </PersistQueryClientProvider>
  )
}
