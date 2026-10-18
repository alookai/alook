import { useEffect, useState } from "react"

type NativeBackMessages = {
  postMessage: (message: string) => void
  onmessage: ((event: MessageEvent<string>) => void) | null
}

export function useNativeBackMessages(backEvent: string, scopeKey?: string) {
  const [insets, setInsets] = useState<{ left: number; right: number } | null>(null)
  useEffect(() => {
    const bridge = (window as Window & { AlookBack?: NativeBackMessages }).AlookBack
    if (!bridge?.postMessage) return
    let documentId: string | null = null
    let generation = 0
    const receive = (event: MessageEvent<string>) => {
      if (!documentId) return
      let payload: unknown
      try { payload = JSON.parse(event.data) } catch { return }
      if (!payload || typeof payload !== "object") return
      const data = payload as Record<string, unknown>
      if (data.document !== documentId || data.href !== location.href) return
      if (data.type === "insets") {
        const { left, right } = data
        if (typeof left !== "number" || !Number.isFinite(left) || left < 0
          || typeof right !== "number" || !Number.isFinite(right) || right < 0 || left + right >= 1) return
        setInsets((current) => current?.left === left && current.right === right ? current : { left, right })
        return
      }
      if (typeof data.generation !== "number" || !Number.isSafeInteger(data.generation)) return
      if (data.type !== "complete" || data.generation <= generation) return
      generation = data.generation
      window.dispatchEvent(new Event(backEvent, { cancelable: true }))
    }
    const subscribe = () => {
      setInsets(null)
      documentId = crypto.randomUUID()
      generation = 0
      bridge.postMessage(JSON.stringify({ type: "subscribe", document: documentId }))
    }
    const unsubscribe = () => {
      const id = documentId
      documentId = null
      if (id) bridge.postMessage(JSON.stringify({ type: "unsubscribe", document: id }))
    }
    const hide = () => { unsubscribe(); setInsets(null) }
    const show = (event: PageTransitionEvent) => { if (event.persisted) subscribe() }
    bridge.onmessage = receive
    subscribe()
    window.addEventListener("pagehide", hide)
    window.addEventListener("pageshow", show)
    return () => {
      window.removeEventListener("pagehide", hide)
      window.removeEventListener("pageshow", show)
      unsubscribe()
      if (bridge.onmessage === receive) bridge.onmessage = null
    }
  }, [backEvent, scopeKey])
  return insets
}
