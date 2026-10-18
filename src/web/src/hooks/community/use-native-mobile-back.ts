import { useEffect, useLayoutEffect, useRef } from "react"
import { useNativeBackMessages } from "./use-native-back-messages"
import { isMobile } from "@alook/shared"
import { requestNativeBack } from "@/components/ui/native-back-layer"

export const NATIVE_MOBILE_BACK_EVENT = "alook:native-back"
export const MOBILE_BACK_EDGE_PX = 24

type NativeBackListener = { unregister: () => Promise<void> }
type TauriBackWindow = Window & {
  __TAURI__?: { app?: { onBackButtonPress?: (callback: () => void) => Promise<NativeBackListener> } }
}

export function useNativeMobileBack({ gestureKey, dismissShellOverlay, parentPath, replacePath, pageNavigationEnabled = true }: {
  mobile?: boolean
  gestureKey?: string
  dismissShellOverlay: () => boolean
  parentPath: string | null
  replacePath: (href: string) => void
  pageNavigationEnabled?: boolean
}) {
  const nativeInsets = useNativeBackMessages(NATIVE_MOBILE_BACK_EVENT, gestureKey)
  const actions = useRef({ dismissShellOverlay, replacePath, pageNavigationEnabled, parentPath })
  const composing = useRef<EventTarget | null>(null)
  useLayoutEffect(() => {
    actions.current = { dismissShellOverlay, replacePath, pageNavigationEnabled, parentPath }
  }, [dismissShellOverlay, replacePath, pageNavigationEnabled, parentPath])
  useEffect(() => {
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
  }, [])
  useEffect(() => {
    const start = (event: CompositionEvent) => { composing.current = event.target }
    const end = () => { composing.current = null }
    const back = (event: Event) => {
      if (!event.cancelable) return
      event.preventDefault()
      if (composing.current === document.activeElement) return
      if (requestNativeBack(document) !== "none" || actions.current.dismissShellOverlay()) return
      if (actions.current.parentPath && actions.current.pageNavigationEnabled) actions.current.replacePath(actions.current.parentPath)
    }
    document.addEventListener("compositionstart", start)
    document.addEventListener("compositionend", end)
    document.addEventListener("focusout", end)
    window.addEventListener(NATIVE_MOBILE_BACK_EVENT, back)
    return () => {
      document.removeEventListener("compositionstart", start)
      document.removeEventListener("compositionend", end)
      document.removeEventListener("focusout", end)
      window.removeEventListener(NATIVE_MOBILE_BACK_EVENT, back)
    }
  }, [])
  return nativeInsets
}
