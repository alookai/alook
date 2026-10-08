import type { PersistedClient } from "@tanstack/react-query-persist-client"

export function operatePerfQueryCache(input: {
  key: string
} & ({
  action: "remove"
} | {
  action: "contains"
  version: number
  buster: string
  queryKey: readonly unknown[]
  channelIds: readonly string[]
})): Promise<boolean> {
  return new Promise((resolve, reject) => {
    let db: IDBDatabase | undefined
    let settled = false
    const finish = (result: boolean, error?: Error | DOMException | null) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      db?.close()
      if (error) reject(error)
      else resolve(result)
    }
    const timeout = setTimeout(() => finish(false, new Error("query cache operation timed out")), 3_000)
    const open = indexedDB.open("keyval-store")
    open.onupgradeneeded = () => {
      open.transaction?.abort()
      open.result.close()
      finish(input.action === "remove")
    }
    open.onerror = () => finish(false, open.error ?? new Error("failed to open query cache"))
    open.onsuccess = () => {
      db = open.result
      if (settled) { db.close(); return }
      if (!db.objectStoreNames.contains("keyval")) {
        finish(false, new Error("query cache store unavailable"))
        return
      }
      const tx = db.transaction("keyval", input.action === "remove" ? "readwrite" : "readonly")
      const store = tx.objectStore("keyval")
      let result = input.action === "remove"
      tx.onerror = tx.onabort = () => finish(false, tx.error ?? new Error("query cache transaction failed"))
      tx.oncomplete = () => finish(result)
      if (input.action === "remove") {
        store.delete(input.key)
        return
      }
      const request = store.get(input.key)
      request.onerror = () => finish(false, request.error ?? new Error("failed to read query cache"))
      request.onsuccess = () => {
        if (typeof request.result !== "string") return
        let client: PersistedClient & { version?: unknown; channelFences?: unknown }
        try { client = JSON.parse(request.result) } catch { return }
        if (!client || client.version !== input.version || client.buster !== input.buster
          || !Array.isArray(client.channelFences) || !Array.isArray(client.clientState?.queries)) return
        const query = client.clientState.queries.find(candidate => (
          Array.isArray(candidate?.queryKey) && candidate.queryKey.length === input.queryKey.length
          && candidate.queryKey.every((value, index) => value === input.queryKey[index])
          && candidate.state?.status === "success"
        ))
        const rows = query?.state.data
        result = Array.isArray(rows) && input.channelIds.length > 0 && input.channelIds.every(channelId => (
          rows.some(row => row && typeof row === "object" && typeof row.id === "string"
            && row.id.length > 0 && row.channelId === channelId)
        ))
      }
    }
  })
}
