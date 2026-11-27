import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react"
import { isMobile } from "@alook/shared"
import {
  hasNativeBackOwner,
  requestNativeBack,
  subscribeNativeBackOwners,
} from "@/components/ui/native-back-layer"

export const NATIVE_MOBILE_BACK_EVENT = "alook:native-back"

type NativeBackListener = { unregister: () => Promise<void> }
type TauriBackWindow = Window & {
  __TAURI__?: {
    app?: { onBackButtonPress?: (callback: () => void) => Promise<NativeBackListener> }
  }
}

const subscribeNativeBackLayer = (callback: () => void) => (
  typeof document === "undefined" ? () => {} : subscribeNativeBackOwners(document, callback)
)
const getNativeBackLayerSnapshot = () => (
  typeof document === "undefined" ? false : hasNativeBackOwner(document)
)
const getServerNativeBackLayerSnapshot = () => false

export function useNativeMobileBack({
  dismissShellOverlay, hasShellOverlay = false, parentPath, replacePath,
}: {
  dismissShellOverlay: () => boolean
  hasShellOverlay?: boolean
  parentPath: string | null
  replacePath: (href: string) => void
}) {
  const actions = useRef({ dismissShellOverlay, parentPath, replacePath })
  const composing = useRef<EventTarget | null>(null)
  const hasNativeBackLayer = useSyncExternalStore(
    subscribeNativeBackLayer,
    getNativeBackLayerSnapshot,
    getServerNativeBackLayerSnapshot,
  )
  const shouldIntercept = parentPath !== null || hasShellOverlay || hasNativeBackLayer
  useLayoutEffect(() => {
    actions.current = { dismissShellOverlay, parentPath, replacePath }
  }, [dismissShellOverlay, parentPath, replacePath])
  useEffect(() => {
    if (!shouldIntercept) return
    if (!isMobile() || !/android/i.test(navigator.userAgent)) return
    const app = (window as TauriBackWindow).__TAURI__?.app
    if (!app?.onBackButtonPress) return
    const register = app.onBackButtonPress.bind(app)
    const report = (error: unknown) => { console.error("Native Back listener failed", error) }
    const subscribe = () => {
      let active = true
      let listener: NativeBackListener | undefined
      void register(() => {
        if (active) window.dispatchEvent(new Event(NATIVE_MOBILE_BACK_EVENT, { cancelable: true }))
      }).then((registered) => {
        if (active) listener = registered
        else void registered.unregister().catch(report)
      }).catch(report)
      return () => {
        if (!active) return
        active = false
        if (listener) void listener.unregister().catch(report)
      }
    }
    let stop = subscribe()
    const hide = () => { stop() }
    const show = (event: PageTransitionEvent) => {
      if (!event.persisted) return
      stop()
      stop = subscribe()
    }
    window.addEventListener("pagehide", hide)
    window.addEventListener("pageshow", show)
    return () => {
      window.removeEventListener("pagehide", hide)
      window.removeEventListener("pageshow", show)
      stop()
    }
  }, [shouldIntercept])
  useEffect(() => {
    const start = (event: CompositionEvent) => { composing.current = event.target }
    const end = () => { composing.current = null }
    const onVisibility = () => { if (document.visibilityState === "hidden") end() }
    document.addEventListener("compositionstart", start)
    document.addEventListener("compositionend", end)
    document.addEventListener("focusout", end)
    window.addEventListener("blur", end, true)
    document.addEventListener("visibilitychange", onVisibility)
    window.addEventListener("pagehide", end)
    return () => {
      end()
      document.removeEventListener("compositionstart", start)
      document.removeEventListener("compositionend", end)
      document.removeEventListener("focusout", end)
      window.removeEventListener("blur", end, true)
      document.removeEventListener("visibilitychange", onVisibility)
      window.removeEventListener("pagehide", end)
    }
  }, [])
  useEffect(() => {
    const handleBack = (event: Event) => {
      if (!event.cancelable) return
      event.preventDefault()
      if (composing.current !== null && composing.current === document.activeElement) return
      const { dismissShellOverlay, parentPath, replacePath } = actions.current
      if (requestNativeBack(document) !== "none" || dismissShellOverlay()) return
      if (parentPath) replacePath(parentPath)
    }
    window.addEventListener(NATIVE_MOBILE_BACK_EVENT, handleBack)
    return () => window.removeEventListener(NATIVE_MOBILE_BACK_EVENT, handleBack)
  }, [])
}
