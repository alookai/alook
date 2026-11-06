"use client"

import { useSyncExternalStore } from "react"

type Geometry = Readonly<{
  top: number
  right: number
  bottom: number
  left: number
  viewportWidth: number
  viewportHeight: number
  caption: boolean
}>
type GeometryState = Readonly<{ status: "pending" | "ready" | "error"; insets: Geometry | null }>
type GeometryWindow = Window & {
  __alookNativeGeometry?: {
    getSnapshot: () => GeometryState
    subscribe: (callback: () => void) => () => void
  }
}
const unknown: GeometryState = Object.freeze({ status: "pending", insets: null })
const serverSnapshot = () => unknown
const snapshot = () => (window as GeometryWindow).__alookNativeGeometry?.getSnapshot() ?? unknown
const subscribe = (callback: () => void) => (window as GeometryWindow).__alookNativeGeometry?.subscribe(callback) ?? (() => {})

export function useNativeGeometry() {
  return useSyncExternalStore(subscribe, snapshot, serverSnapshot)
}
