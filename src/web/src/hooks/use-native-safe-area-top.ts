"use client"

import { isMobile } from "@alook/shared"
import { useNativeGeometry } from "./use-native-geometry"

export function useNativeSafeAreaTop() {
  const geometry = useNativeGeometry()
  return isMobile() ? geometry.insets?.top ?? null : null
}
