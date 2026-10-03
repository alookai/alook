"use client"

import { useEffect } from "react"
import { createStore, useSelector } from "@tanstack/react-store"

const HOME_PET_ENABLED_STORAGE_KEY = "alook-home-pet-enabled-v1"
export type HomePetSettings = { enabled: boolean }
const settings = createStore<HomePetSettings>({ enabled: false })
function publish(next: HomePetSettings) { settings.setState((current) => current.enabled === next.enabled ? current : next); return settings.get() }
export function readHomePetSettings(): HomePetSettings {
  if (typeof window === "undefined") return { enabled: false }
  try { return publish({ enabled: window.localStorage.getItem(HOME_PET_ENABLED_STORAGE_KEY) === "true" }) } catch { return settings.get() }
}
export function writeHomePetSettings(patch: Partial<HomePetSettings>) {
  const next = publish({ ...readHomePetSettings(), ...patch })
  try { window.localStorage.setItem(HOME_PET_ENABLED_STORAGE_KEY, String(next.enabled)) } catch {}
  return next
}
export function useHomePetSettings() {
  const current = useSelector(settings, (state) => state)
  useEffect(() => {
    readHomePetSettings()
    const onStorage = (event: StorageEvent) => { if (event.key === HOME_PET_ENABLED_STORAGE_KEY || event.key === null) readHomePetSettings() }
    window.addEventListener("storage", onStorage)
    return () => window.removeEventListener("storage", onStorage)
  }, [])
  return current
}
