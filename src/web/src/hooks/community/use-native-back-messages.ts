import { useEffect, useState } from "react"

type NativeBackMessages = {
  postMessage: (message: string) => void
  onmessage: ((event: MessageEvent<string>) => void) | null
}

export function useNativeBackMessages(backEvent: string, progressEvent: string) {
  const [insets, setInsets] = useState<{ left: number; right: number } | null>(null)
  useEffect(() => {
    const bridge = (window as Window & { AlookBack?: NativeBackMessages }).AlookBack
    if (!bridge?.postMessage) return
    let documentId: string | null = null
    let generation = 0
    let activeGeneration: number | null = null
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
      const next = data.generation
      if (data.type === "start") {
        if (next <= generation || data.progress !== 0) return
        generation = next
        activeGeneration = next
        window.dispatchEvent(new CustomEvent(progressEvent, { detail: { progress: 0, started: true } }))
      } else if (data.type === "progress") {
        if (next !== activeGeneration || typeof data.progress !== "number"
          || !Number.isFinite(data.progress) || data.progress < 0 || data.progress > 1) return
        window.dispatchEvent(new CustomEvent(progressEvent, { detail: { progress: data.progress } }))
      } else if (data.type === "cancel") {
        if (next !== activeGeneration) return
        activeGeneration = null
        window.dispatchEvent(new CustomEvent(progressEvent, { detail: { progress: null } }))
      } else if (data.type === "complete") {
        if (next !== activeGeneration && next <= generation) return
        if (next !== activeGeneration) {
          window.dispatchEvent(new CustomEvent(progressEvent, { detail: { progress: null } }))
        }
        generation = next
        activeGeneration = null
        window.dispatchEvent(new Event(backEvent, { cancelable: true }))
      }
    }
    const subscribe = () => {
      setInsets(null)
      documentId = crypto.randomUUID()
      generation = 0
      activeGeneration = null
      bridge.postMessage(JSON.stringify({ type: "subscribe", document: documentId }))
    }
    const unsubscribe = () => {
      const id = documentId
      documentId = null
      activeGeneration = null
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
  }, [backEvent, progressEvent])
  return insets
}
