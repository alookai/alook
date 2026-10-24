"use client"

import { useSyncExternalStore } from "react"

const subscribe = () => () => {}

export function useHydratedClient() {
  return useSyncExternalStore(subscribe, () => true, () => false)
}
