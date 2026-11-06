"use client"

import { useLayoutEffect, useState } from "react"
import { useNativeGeometry } from "./use-native-geometry"
import { useNativeKeyboard } from "./use-native-keyboard"

export function useSafeAreaBoundary() {
  const geometry = useNativeGeometry()
  const keyboard = useNativeKeyboard()
  const [boundary, setBoundary] = useState<DOMRect>()
  useLayoutEffect(() => {
    const element = document.querySelector<HTMLElement>('[data-slot="app-safe-bounds"]')
    if (!element) return
    const measure = () => setBoundary(element.getBoundingClientRect())
    measure()
    window.addEventListener("resize", measure)
    return () => window.removeEventListener("resize", measure)
  }, [geometry, keyboard])
  return boundary
}
