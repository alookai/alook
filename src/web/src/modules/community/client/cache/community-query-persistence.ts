import type { PersistedClient, Persister } from "@tanstack/react-query-persist-client"
import type { MessagesPage, Msg } from "@/lib/community/models/message"
import { createUserScopedIdbPersister } from "@/platform/client"

/**
 * Buster tag paired with `PersistedClient`. TanStack throws away restored
 * state whose buster doesn't match — a cheap secondary lever when just the
 * shape of a specific query needs to be reset without touching the IDB
 * namespace.
 */
export const COMMUNITY_QUERY_PERSIST_BUSTER = "v1"

/** Persister max-age; queries older than this are discarded on restore. */
export const COMMUNITY_QUERY_PERSIST_MAX_AGE_MS = 24 * 60 * 60 * 1000

/**
 * Only these query-key kinds are persisted. Everything else refetches on mount
 * — presence, live server list, member rosters, etc. are cheap and should
 * always reflect the live server.
 *
 * Note: read-state snapshots were previously persisted but were removed to
 * kill a self-inflicted staleness bug — a hydrated snapshot with a stale
 * `lastReadMessageId` would anchor the "New" divider to a row that had long
 * since scrolled off. The snapshot hooks now refetch on every mount, so
 * persisting them is a strict downside (bytes on disk + risk of drift).
 */
const PERSISTED_KINDS = new Set<string>([
  "channelMessages",
  "dmMessages",
])

// Query keys start with `["community", <kind>, ...]` — the first segment is
// the namespace, the second segment is a discriminator (`"channel"`, `"dm"`,
// `"servers"`, …), and for message queries the third+ segments carry the id
// and the literal `"messages"` / `"read-state-snapshot"` tail. See
// `src/web/src/lib/query-keys.ts`.
function keyKindFor(queryKey: readonly unknown[]): string | null {
  if (!Array.isArray(queryKey) || queryKey.length < 2) return null
  if (queryKey[0] !== "community") return null
  const second = queryKey[1]
  // Message queries: ["community", "channel", <id>, "messages"] or
  // ["community", "dm", <id>, "messages"].
  if (second === "channel" || second === "dm") {
    const tail = queryKey[queryKey.length - 1]
    if (tail === "messages") {
      return second === "channel" ? "channelMessages" : "dmMessages"
    }
    if (tail === "read-state-snapshot") {
      return second === "channel"
        ? "channelReadStateSnapshot"
        : "dmReadStateSnapshot"
    }
  }
  return null
}

export function shouldPersistQueryKey(queryKey: readonly unknown[]): boolean {
  const kind = keyKindFor(queryKey)
  return kind !== null && PERSISTED_KINDS.has(kind)
}

/**
 * Trust rule for the first page of a persisted message stream.
 *
 * Persistence is only safe when the cached window represents "we know we have
 * the newest tail." A since-mode or older-only envelope has no `hasMore` flag
 * on `pages[0]`, so the tail-of-history read (`oldestPage.hasMoreOlder ??
 * oldestPage.hasMore ?? false`) collapses to `false` on the next mount and
 * the UI silently loses history until a manual cache clear.
 *
 * Trusted shapes:
 * - Legacy newest-mode: `hasMore !== undefined && hasMoreOlder === undefined
 *   && hasMoreNewer === undefined`. This is the pre-anchor cache shape.
 * - Anchor-mode with the tail attached: `hasMoreNewer === false`. Guarantees
 *   the client has loaded everything up to the current latestSeq, so the
 *   window on disk is a real newest-side window we can safely hand to the
 *   next mount.
 */
export function isTrustedMessagesPageZero(page: MessagesPage | undefined): boolean {
  if (!page) return false
  const isLegacyNewest =
    page.hasMore !== undefined &&
    page.hasMoreOlder === undefined &&
    page.hasMoreNewer === undefined
  if (isLegacyNewest) return true
  // Defense-in-depth (paired with buildSinceResponse now emitting an older-side
  // signal): a page is only a trustworthy standalone tail if the NEXT mount can
  // read back through it. `hasMoreNewer === false` alone isn't enough — a since
  // page carried that yet lacked any older signal, so rehydrating it as the
  // sole page stranded scroll-up (the bug this guards). Require an older-side
  // signal (`hasMoreOlder`/`hasMore` present) so a page that can't self-report
  // its older edge never survives to disk, whatever produced it.
  if (
    page.hasMoreNewer === false &&
    (page.hasMoreOlder !== undefined || page.hasMore !== undefined)
  ) {
    return true
  }
  return false
}

/**
 * Query-level filter used by both `shouldDehydrateQuery` (write side) and
 * `scrubCommunityPersistedClient` (read side of the same walk). Non-message queries
 * fall through to `shouldPersistQueryKey`; message queries additionally check
 * `pages[0]` shape so a stale/mid-history cache never survives to the next
 * mount.
 */
export function shouldPersistQuery(
  queryKey: readonly unknown[],
  data: unknown,
): boolean {
  if (!shouldPersistQueryKey(queryKey)) return false
  const kind = keyKindFor(queryKey)
  if (kind !== "channelMessages" && kind !== "dmMessages") return true
  const pages = (data as { pages?: MessagesPage[] } | undefined)?.pages
  if (!Array.isArray(pages) || pages.length === 0) return false
  return isTrustedMessagesPageZero(pages[0])
}

/**
 * Optimistic rows carry an id that starts with `temp_` until the server
 * assigns a real id. Persisting them would surface ghost rows on reload — the
 * outgoing POST may never have committed, and if it did, the WS layer will
 * re-deliver the real message with the canonical id. Also strips `failed:
 * true` rows since they only exist to prompt a retry that no longer makes
 * sense once the tab has been closed.
 */
function scrubMessage(m: Msg): boolean {
  if (typeof m.id === "string" && m.id.startsWith("temp_")) return false
  if (m.failed === true) return false
  return true
}

function scrubPage(page: MessagesPage): MessagesPage {
  const messages = page.messages.filter(scrubMessage)
  if (messages.length === page.messages.length) return page
  return { ...page, messages }
}

/**
 * Walk the dehydrated client and:
 * 1. Drop optimistic / failed message rows from each page (temp_/failed rows
 *    would surface as ghosts on the next mount — see `scrubMessage`).
 * 2. Drop the whole query when its trimmed `pages[0]` no longer represents a
 *    trusted newest-tail cache. TanStack's dehydrate step already ran the
 *    `shouldDehydrateQuery` predicate against the *pre-scrub* data; if
 *    scrubbing changed the shape (or the shape was borderline to begin with),
 *    re-run the invariant here so nothing untrustworthy hits disk.
 *
 * Mutates a shallow copy — the live QueryClient cache is untouched. Called
 * from the persister's `serialize` hook, so the filter is applied every time
 * TanStack throttles a save.
 */
function scrubCommunityPersistedClient(
  client: PersistedClient,
): PersistedClient {
  const queries: typeof client.clientState.queries = []
  for (const q of client.clientState.queries) {
    const kind = keyKindFor(q.queryKey)
    if (kind !== "channelMessages" && kind !== "dmMessages") {
      queries.push(q)
      continue
    }
    const data = q.state.data as
      | { pages: MessagesPage[]; pageParams: unknown[] }
      | undefined
    if (!data || !Array.isArray(data.pages)) continue
    const pages = data.pages.map(scrubPage)
    const nextData = { ...data, pages }
    if (!shouldPersistQuery(q.queryKey, nextData)) continue
    queries.push({ ...q, state: { ...q.state, data: nextData } })
  }
  return {
    ...client,
    clientState: { ...client.clientState, queries },
  }
}

export function createCommunityQueryPersister(
  userId: string | null,
): Persister {
  return createUserScopedIdbPersister({
    userId,
    serialize: (client) => JSON.stringify(scrubCommunityPersistedClient(client)),
  })
}
