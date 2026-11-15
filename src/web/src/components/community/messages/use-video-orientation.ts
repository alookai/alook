"use client"

import { useCallback, useRef, useSyncExternalStore } from "react"
import { deviceOrientation } from "@/lib/device-orientation"
import { playerRelativeRotation, type PlayerRotation } from "./video-orientation"

export function useVideoOrientation(expanded: boolean) {
  const rotation = useRef<PlayerRotation>(0)
  const prepare = useCallback(() => {
    rotation.current = 0
    void deviceOrientation.requestPermission()
  }, [])
  const subscribe = useCallback((notify: () => void) => {
    if (!expanded) { rotation.current = 0; return () => undefined }
    const changed = () => {
      const sample = deviceOrientation.getSnapshot()
      if (sample.availability !== "available" || sample.physicalAngle === null) return
      const next = playerRelativeRotation(sample.physicalAngle, sample.interfaceAngle)
      if (rotation.current !== next) { rotation.current = next; notify() }
    }
    const stop = deviceOrientation.subscribe(changed)
    changed()
    return stop
  }, [expanded])
  const snapshot = useCallback(() => expanded ? rotation.current : 0, [expanded])
  return { rotation: useSyncExternalStore<PlayerRotation>(subscribe, snapshot, () => 0), prepare }
}
