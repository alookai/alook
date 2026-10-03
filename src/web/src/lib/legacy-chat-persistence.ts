const LEGACY_PREFIX = "alook-chat-cache-"

function assertRead(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException("Cancelled legacy cache read", "AbortError")
}

async function legacyDatabaseNames(): Promise<string[]> {
  if (typeof indexedDB === "undefined" || typeof indexedDB.databases !== "function") {
    throw new Error("Local cache could not be listed on this browser. Device cache has not been fully cleared.")
  }
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    const databases = await Promise.race([
      indexedDB.databases(),
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("Enumeration timed out")), 5000) }),
    ])
    return databases.flatMap((database) => database.name?.startsWith(LEGACY_PREFIX) ? [database.name] : [])
  } catch {
    throw new Error("Local cache could not be listed. Close other tabs and try again; device cache has not been fully cleared.")
  } finally {
    clearTimeout(timeout)
  }
}

async function readLegacyDatabaseBytes(name: string, signal?: AbortSignal): Promise<number> {
  assertRead(signal)
  return new Promise<number>((resolve, reject) => {
    const request = indexedDB.open(name)
    let finished = false
    const timeout = setTimeout(() => fail(new Error("Local cache could not be read. Close other tabs and try again.")), 5000)
    const fail = (error: unknown) => { finished = true; clearTimeout(timeout); reject(error) }
    request.onupgradeneeded = () => request.transaction?.abort()
    request.onerror = () => fail(request.error)
    request.onblocked = () => fail(new Error("Local cache is busy. Close other tabs and try again."))
    request.onsuccess = () => {
      const db = request.result
      if (finished) { db.close(); return }
      try {
        assertRead(signal)
        const names = [...db.objectStoreNames]
        if (!names.length) { finished = true; clearTimeout(timeout); db.close(); resolve(0); return }
        let bytes = 0
        const transaction = db.transaction(names, "readonly")
        const abort = () => transaction.abort()
        signal?.addEventListener("abort", abort, { once: true })
        const close = () => { clearTimeout(timeout); signal?.removeEventListener("abort", abort); db.close() }
        db.onversionchange = () => { transaction.abort(); db.close() }
        transaction.oncomplete = () => { finished = true; close(); resolve(bytes) }
        transaction.onabort = () => { close(); fail(signal?.aborted ? new DOMException("Cancelled legacy cache read", "AbortError") : transaction.error ?? new Error("Legacy cache read interrupted")) }
        for (const store of names) {
          const cursorRequest = transaction.objectStore(store).openCursor()
          cursorRequest.onsuccess = () => {
            const cursor = cursorRequest.result
            if (!cursor) return
            try { bytes += new TextEncoder().encode(JSON.stringify(cursor.value) ?? "").byteLength } catch { transaction.abort(); return }
            cursor.continue()
          }
        }
      } catch (error) { db.close(); fail(error) }
    }
  })
}

export async function getLegacyChatCacheSizeBytes(signal?: AbortSignal): Promise<number> {
  assertRead(signal)
  const names = await legacyDatabaseNames()
  let bytes = 0
  for (const name of names) bytes += await readLegacyDatabaseBytes(name, signal)
  assertRead(signal)
  return bytes
}

export async function clearLegacyChatCaches(): Promise<void> {
  const names = await legacyDatabaseNames()
  for (const name of names) await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name)
    const timeout = setTimeout(() => reject(new Error("Local cache deletion timed out. Close other tabs and try again; device cache has not been fully cleared.")), 5000)
    request.onsuccess = () => { clearTimeout(timeout); resolve() }
    request.onerror = () => { clearTimeout(timeout); reject(request.error) }
    request.onblocked = () => { clearTimeout(timeout); reject(new Error("Close other tabs using Alook and try again. Device cache has not been fully cleared.")) }
  })
}
