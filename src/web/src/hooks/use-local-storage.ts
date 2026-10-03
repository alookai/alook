"use client"

import { useMemo, useLayoutEffect, useCallback } from "react"
import { useCreateAtom, useSelector } from "@tanstack/react-store"
import { useApplicationOwner, assertApplicationOwner } from "@/lib/application-owner"

export function useLocalStorage<T>(key: string, initialValue: T): [T, (value: T | ((prev: T) => T)) => void] {
  const owner = useApplicationOwner()
  const generation = useSelector(owner.lifecycle, (state) => state.generation)
  const token = useMemo(() => ({ owner, generation }), [owner, generation])
  const storageKey = `alook:${owner.userId}:ui:${key}`
  const defaults = useCreateAtom({ owner, key, value: initialValue })
  const committedDefault = useSelector(defaults, (state) => state)
  const fallback = committedDefault.owner === owner && committedDefault.key === key ? committedDefault.value : initialValue
  useLayoutEffect(() => {
    if (defaults.get().owner !== owner || defaults.get().key !== key) defaults.set({ owner, key, value: initialValue })
  }, [defaults, owner, key, initialValue])
  const stored = useSelector(owner.preferences, (state) => state.localValues.has(key) ? state.localValues.get(key) as T : fallback)
  useLayoutEffect(() => {
    const hydrate = () => {
      try { assertApplicationOwner(token) } catch { return }
      let next = fallback
      try { const item = localStorage.getItem(storageKey); if (item !== null) next = JSON.parse(item) as T } catch {}
      owner.preferences.setState((state) => {
        if (Object.is(state.localValues.get(key), next) && state.localValues.has(key)) return state
        const localValues = new Map(state.localValues); localValues.set(key, next)
        return { ...state, localValues }
      })
    }
    hydrate()
    const onStorage = (event: StorageEvent) => { if (event.key === storageKey || event.key === null) hydrate() }
    window.addEventListener("storage", onStorage)
    return () => window.removeEventListener("storage", onStorage)
  }, [owner, token, key, storageKey, fallback])
  const setValue = useCallback((value: T | ((prev: T) => T)) => {
    try { assertApplicationOwner(token) } catch { return }
    const previous = owner.preferences.get().localValues.has(key) ? owner.preferences.get().localValues.get(key) as T : fallback
    const next = typeof value === "function" ? (value as (prev: T) => T)(previous) : value
    owner.preferences.setState((state) => { const localValues = new Map(state.localValues); localValues.set(key, next); return { ...state, localValues } })
    try { localStorage.setItem(storageKey, JSON.stringify(next)) } catch {}
  }, [owner, token, key, storageKey, fallback])
  return [stored, setValue]
}
