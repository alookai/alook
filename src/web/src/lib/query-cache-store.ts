import { createStore, promisifyRequest } from "idb-keyval"

export const cacheStore = createStore("keyval-store", "keyval")

export async function cacheTransaction<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => Promise<T>,
): Promise<T> {
  return cacheStore(mode, async (store) => {
    const committed = promisifyRequest(store.transaction)
    try {
      const result = await operation(store)
      await committed
      return result
    } catch (error) {
      await committed.catch(() => undefined)
      throw error
    }
  })
}
