import { useEffect, useLayoutEffect, useRef } from "react"
import { isMobile } from "@alook/shared"
import { requestNativeBack } from "@/components/ui/native-back-layer"

export const NATIVE_MOBILE_BACK_EVENT = "alook:native-back"

type NativeBackListener = { unregister: () => Promise<void> }
type TauriBackWindow = Window & {
  __TAURI__?: {
    app?: { onBackButtonPress?: (callback: () => void) => Promise<NativeBackListener> }
  }
}

export function useNativeMobileBack({
  dismissShellOverlay, parentPath, replacePath,
}: {
  dismissShellOverlay: () => boolean
  parentPath: string | null
  replacePath: (href: string) => void
}) {
  const actions = useRef({ dismissShellOverlay, parentPath, replacePath })
  const composing = useRef<EventTarget | null>(null)
  useLayoutEffect(() => {
    actions.current = { dismissShellOverlay, parentPath, replacePath }
  }, [dismissShellOverlay, parentPath, replacePath])
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
    document.addEventListener("compositionstart", start)
    document.addEventListener("compositionend", end)
    document.addEventListener("focusout", end)
    return () => {
      end()
      document.removeEventListener("compositionstart", start)
      document.removeEventListener("compositionend", end)
      document.removeEventListener("focusout", end)
    }
  }, [])
  useEffect(() => {
    const handleBack = (event: Event) => {
      if (!event.cancelable) return
      event.preventDefault()
      if (composing.current === document.activeElement) return
      const { dismissShellOverlay, parentPath, replacePath } = actions.current
      if (requestNativeBack(document) !== "none" || dismissShellOverlay()) return
      if (parentPath) replacePath(parentPath)
    }
    window.addEventListener(NATIVE_MOBILE_BACK_EVENT, handleBack)
    return () => window.removeEventListener(NATIVE_MOBILE_BACK_EVENT, handleBack)
  }, [])
}
