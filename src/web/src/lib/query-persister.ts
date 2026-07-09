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
 */
const PERSISTED_KINDS = new Set<string>([
  "channelMessages",
  "dmMessages",
  "channelReadStateSnapshot",
  "dmReadStateSnapshot",
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
 * Walk the dehydrated client and drop optimistic / failed message rows before
 * they hit disk. Mutates a shallow copy — the live QueryClient cache is
 * untouched. Called from the persister's `serialize` hook, so the filter is
 * applied every time TanStack throttles a save.
 */
function scrubDehydratedClient(client: PersistedClient): PersistedClient {
  const queries = client.clientState.queries.map((q) => {
    const kind = keyKindFor(q.queryKey)
    if (kind !== "channelMessages" && kind !== "dmMessages") return q
    const data = q.state.data as
      | { pages: MessagesPage[]; pageParams: unknown[] }
      | undefined
    if (!data || !Array.isArray(data.pages)) return q
    const pages = data.pages.map(scrubPage)
    return {
      ...q,
      state: { ...q.state, data: { ...data, pages } },
    }
  })
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
