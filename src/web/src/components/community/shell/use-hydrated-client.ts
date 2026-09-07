"use client"

import { useSyncExternalStore } from "react"

const subscribe = () => () => {}

/**
 * False for SSR and the matching hydration render, then true on the client.
 * Use this when browser-only persisted state would otherwise change SSR output.
 */
export function useHydratedClient() {
  return useSyncExternalStore(subscribe, () => true, () => false)
}
