import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister"
import type {
  PersistedClient,
  Persister,
} from "@tanstack/react-query-persist-client"
import { del, get, set } from "idb-keyval"
import type { Msg } from "@/components/community/_types"
import type { MessagesPage } from "@/hooks/community/use-messages"

/**
 * IDB namespace root. Bumping the tail segment (`v1` → `v2`) invalidates every
 * cached payload — use it as the escape hatch when the persisted query shape
 * changes in a way the runtime can't reconcile against fresh server data.
 */
const IDB_PREFIX = "alook:qc:v1"

/**
 * Buster tag paired with `PersistedClient`. TanStack throws away restored
 * state whose buster doesn't match — a cheap secondary lever when just the
 * shape of a specific query needs to be reset without touching the IDB
 * namespace.
 */
export const PERSIST_BUSTER = "v1"

/** Persister max-age; queries older than this are discarded on restore. */
export const PERSIST_MAX_AGE_MS = 24 * 60 * 60 * 1000

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
  if (page.hasMoreNewer === false) return true
  return false
}

/**
 * Query-level filter used by both `shouldDehydrateQuery` (write side) and
 * `scrubDehydratedClient` (read side of the same walk). Non-message queries
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
function scrubDehydratedClient(client: PersistedClient): PersistedClient {
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

/** IDB key namespace for a given user. `null` = pre-auth or logged out. */
function namespaceFor(userId: string | null): string {
  return `${IDB_PREFIX}:${userId ?? "anon"}`
}

/** Storage sub-key for the persister blob within a user's namespace. */
function blobKeyFor(userId: string | null): string {
  return `${namespaceFor(userId)}:client`
}

/**
 * Create an async-storage persister scoped to a specific user id.
 *
 * Every read/write is namespaced by `userId` so signing in as a different
 * account never surfaces the previous user's cached rows. `serialize` scrubs
 * `temp_*` and `failed: true` rows before they hit disk (see `scrubMessage`).
 */
export function createIdbPersister(userId: string | null): Persister {
  const key = blobKeyFor(userId)
  return createAsyncStoragePersister({
    storage: {
      getItem: async (_k: string) => {
        const value = await get<string>(key)
        return value ?? null
      },
      setItem: async (_k: string, value: string) => {
        await set(key, value)
      },
      removeItem: async (_k: string) => {
        await del(key)
      },
    },
    // Passed to storage under the covers, but our storage adapter ignores the
    // key argument (we own the namespace). Leaving a stable literal keeps the
    // persister's internal throttle bookkeeping predictable.
    key: "alook-query-cache",
    serialize: (client) => JSON.stringify(scrubDehydratedClient(client)),
    deserialize: (raw) => JSON.parse(raw) as PersistedClient,
  })
}

/**
 * Delete the persisted blob for a given user id. Wire into the sign-out flow
 * so a shared machine doesn't leak the previous session's cached message
 * history to the next tab.
 */
export async function clearPersistedCache(userId: string | null): Promise<void> {
  await del(blobKeyFor(userId))
}
