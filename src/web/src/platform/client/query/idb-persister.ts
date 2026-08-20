import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister"
import type {
  PersistedClient,
  Persister,
} from "@tanstack/react-query-persist-client"
import { del, get, set } from "idb-keyval"

const QUERY_CACHE_IDB_PREFIX = "alook:qc:v1"

// `createAsyncStoragePersister` throttles writes but does not expose a way to
// cancel a write that is already waiting inside its throttle. Clearing a
// user's QueryClient during sign-out schedules an empty snapshot; without a
// fence, that stale write can recreate the IDB key after sign-out deletion.
// Each persister captures the current epoch and stale instances lose write
// access as soon as the user's cache is explicitly cleared. A newly mounted
// persister captures the incremented epoch and can persist normally.
const userPersisterEpochs = new Map<string, number>()

type UserScopedIdbPersisterOptions = Readonly<{
  userId: string | null
  serialize?: (client: PersistedClient) => string | Promise<string>
  deserialize?: (raw: string) => PersistedClient | Promise<PersistedClient>
}>

function queryCacheBlobKey(userId: string | null): string {
  return `${QUERY_CACHE_IDB_PREFIX}:${userId ?? "anon"}:client`
}

export function createUserScopedIdbPersister({
  userId,
  serialize = JSON.stringify,
  deserialize = (raw) => JSON.parse(raw) as PersistedClient,
}: UserScopedIdbPersisterOptions): Persister {
  const key = queryCacheBlobKey(userId)
  const epoch = userPersisterEpochs.get(key) ?? 0
  return createAsyncStoragePersister({
    storage: {
      getItem: async () => (await get<string>(key)) ?? null,
      setItem: async (_storageKey, value) => {
        if ((userPersisterEpochs.get(key) ?? 0) !== epoch) return
        await set(key, value)
      },
      removeItem: async () => del(key),
    },
    key: "alook-query-cache",
    serialize,
    deserialize,
  })
}

export async function clearPersistedQueryCache(
  userId: string | null,
): Promise<void> {
  const key = queryCacheBlobKey(userId)
  userPersisterEpochs.set(key, (userPersisterEpochs.get(key) ?? 0) + 1)
  await del(key)
}
