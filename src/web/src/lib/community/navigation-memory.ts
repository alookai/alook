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
    localStorage.setItem(key, value)
  } catch {
    return
  }
}

export function clearNavigationMemory(key: string): void {
  if (typeof window === "undefined") return
  try {
    localStorage.removeItem(key)
  } catch {
    return
  }
}
