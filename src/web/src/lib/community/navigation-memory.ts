const MEMORY_CHANGED = "community:navigation-memory-changed"

export function subscribeNavigationMemory(notify: () => void): () => void {
  if (typeof window === "undefined") return () => {}
  window.addEventListener(MEMORY_CHANGED, notify)
  window.addEventListener("storage", notify)
  return () => {
    window.removeEventListener(MEMORY_CHANGED, notify)
    window.removeEventListener("storage", notify)
  }
}

export function readNavigationMemory(key: string): string | null {
  if (typeof window === "undefined") return null
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

export function writeNavigationMemory(key: string, value: string): void {
  if (typeof window === "undefined") return
  try {
    if (localStorage.getItem(key) === value) return
    localStorage.setItem(key, value)
  } catch {
    return
  }
  window.dispatchEvent(new Event(MEMORY_CHANGED))
}

export function clearNavigationMemory(key: string): void {
  if (typeof window === "undefined") return
  try {
    if (localStorage.getItem(key) === null) return
    localStorage.removeItem(key)
  } catch {
    return
  }
  window.dispatchEvent(new Event(MEMORY_CHANGED))
}
