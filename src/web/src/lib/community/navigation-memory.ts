const MEMORY_CHANGED = "community:navigation-memory-changed"

const memoryCache = new Map<string, string | null>()
let cachedNonNullCount = 0
let activeSubscribers = 0
let cachedStorageRef: Storage | null = null

function clearCache(): void {
  memoryCache.clear()
  cachedNonNullCount = 0
}

function deleteCached(key: string): void {
  const previous = memoryCache.get(key)
  if (previous !== undefined && previous !== null) cachedNonNullCount -= 1
  memoryCache.delete(key)
}

function setCached(key: string, value: string | null): void {
  const previous = memoryCache.get(key)
  if (previous !== undefined && previous !== null) cachedNonNullCount -= 1
  if (value !== null) cachedNonNullCount += 1
  memoryCache.set(key, value)
}

function syncStorageRef(): Storage | null {
  if (typeof localStorage === "undefined") return null
  if (cachedStorageRef !== localStorage) {
    clearCache()
    cachedStorageRef = localStorage
  }
  return localStorage
}

export function subscribeNavigationMemory(notify: () => void): () => void {
  if (typeof window === "undefined" || typeof window.addEventListener !== "function") return () => {}
  if (activeSubscribers === 0) clearCache()
  activeSubscribers += 1
  const onStorage = (event: StorageEvent) => {
    if (event.key === null) clearCache()
    else deleteCached(event.key)
    notify()
  }
  window.addEventListener(MEMORY_CHANGED, notify)
  window.addEventListener("storage", onStorage)
  return () => {
    window.removeEventListener(MEMORY_CHANGED, notify)
    window.removeEventListener("storage", onStorage)
    activeSubscribers = Math.max(0, activeSubscribers - 1)
    if (activeSubscribers === 0) clearCache()
  }
}

export function readNavigationMemory(key: string): string | null {
  if (typeof window === "undefined") return null
  try {
    const storage = syncStorageRef()
    if (!storage) return null
    if (activeSubscribers > 0) {
      if (cachedNonNullCount > 0 && storage.length === 0) clearCache()
      if (memoryCache.has(key)) return memoryCache.get(key)!
      const value = storage.getItem(key)
      setCached(key, value)
      return value
    }
    return storage.getItem(key)
  } catch {
    return null
  }
}

export function writeNavigationMemory(key: string, value: string): void {
  if (typeof window === "undefined") return
  try {
    const storage = syncStorageRef()
    if (!storage) return
    if (readNavigationMemory(key) === value) return
    storage.setItem(key, value)
    if (activeSubscribers > 0) setCached(key, value)
  } catch {
    return
  }
  if (typeof window.dispatchEvent === "function") {
    window.dispatchEvent(new Event(MEMORY_CHANGED))
  }
}

export function clearNavigationMemory(key: string): void {
  if (typeof window === "undefined") return
  try {
    const storage = syncStorageRef()
    if (!storage) return
    if (readNavigationMemory(key) === null) return
    storage.removeItem(key)
    if (activeSubscribers > 0) setCached(key, null)
  } catch {
    return
  }
  if (typeof window.dispatchEvent === "function") {
    window.dispatchEvent(new Event(MEMORY_CHANGED))
  }
}
