"use client"

import { useAtom, useCreateAtom } from "@tanstack/react-store"
import { useCallback, useEffect, useRef } from "react"
import type { NativeOauthProvider } from "@alook/shared"
import {
  createNativeOauthController,
  nativeOauthBrowserDeps,
  type NativeOauthView,
} from "@/lib/native-oauth-client"

export type NativeOauthHandle = {
  view: NativeOauthView | null
  lastProvider: NativeOauthProvider
  start: (provider: NativeOauthProvider, redirectPath: string) => void
  cancel: () => void
}

export function useNativeOauth(enabled: boolean): NativeOauthHandle | undefined {
  const controllerRef = useRef<ReturnType<typeof createNativeOauthController> | null>(null)
  const [view, setView] = useAtom(useCreateAtom<NativeOauthView | null>(null))
  const [lastProvider, setLastProvider] = useAtom(useCreateAtom<NativeOauthProvider>("github"))

  useEffect(() => {
    if (!enabled) return
    const instance = createNativeOauthController(nativeOauthBrowserDeps, (nextView) => {
      setView(nextView)
    })
    controllerRef.current = instance
    void instance.connect()
    return () => {
      instance.dispose()
      if (controllerRef.current === instance) {
        controllerRef.current = null
      }
    }
  }, [enabled, setView])

  const start = useCallback(
    (provider: NativeOauthProvider, redirectPath: string) => {
      setLastProvider(provider)
      if (controllerRef.current) {
        void controllerRef.current.start(provider, redirectPath)
      }
    },
    [setLastProvider],
  )

  const cancel = useCallback(() => {
    void controllerRef.current?.cancel()
  }, [])

  if (!enabled) return undefined
  return { view, lastProvider, start, cancel }
}
