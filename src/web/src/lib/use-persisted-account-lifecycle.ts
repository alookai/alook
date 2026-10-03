"use client"

import { useEffect } from "react"
import { useSelector } from "@tanstack/react-store"
import { CACHE_INVALIDATION_STORAGE_KEY, cacheInvalidation, type QualifiedPersister } from "@/lib/query-persister"

export function usePersistedAccountLifecycle(persister: QualifiedPersister, onRetired: () => void) {
  const version = useSelector(cacheInvalidation, (state) => state)
  useEffect(() => {
    let active = true
    const check = async () => {
      try { if (!await persister.isCurrent() && active) onRetired() } catch {}
    }
    const onStorage = (event: StorageEvent) => {
      if (event.key === CACHE_INVALIDATION_STORAGE_KEY || event.key === null) void check()
    }
    const onResume = () => { if (document.visibilityState !== "hidden") void check() }
    void check()
    window.addEventListener("storage", onStorage)
    window.addEventListener("pageshow", onResume)
    window.addEventListener("focus", onResume)
    document.addEventListener("visibilitychange", onResume)
    return () => { active = false; window.removeEventListener("storage", onStorage); window.removeEventListener("pageshow", onResume); window.removeEventListener("focus", onResume); document.removeEventListener("visibilitychange", onResume) }
  }, [onRetired, persister, version])
}
