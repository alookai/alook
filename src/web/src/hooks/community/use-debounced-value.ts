"use client"

import { useEffect, useState } from "react"

export function useDebouncedValue<T>(value: T, delayMs: number, immediateWhen?: (value: T) => boolean): T {
  const [debounced, setDebounced] = useState(value)
  const immediate = (immediateWhen?.(value) ?? false) || delayMs <= 0

  useEffect(() => {
    if (immediate) return
    const timer = setTimeout(() => {
      setDebounced(value)
    }, delayMs)
    return () => clearTimeout(timer)
  }, [value, delayMs, immediate])

  return immediate ? value : debounced
}
