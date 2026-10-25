type Unlisten = () => void | Promise<void>
type NativeWindow = {
  listen: (event: string, handler: () => void) => Promise<Unlisten>
}
type LifecycleWindow = Window & {
  __TAURI__?: { window?: { getCurrentWindow?: () => NativeWindow } }
}

export function listenNativeWindowLifecycle(handlers: { resumed: () => void; suspended: () => void }): () => void {
  if (typeof window === "undefined") return () => undefined
  let current: NativeWindow | undefined
  try { current = (window as LifecycleWindow).__TAURI__?.window?.getCurrentWindow?.() } catch {
    console.warn("[ws] native lifecycle window unavailable")
  }
  if (!current) return () => undefined
  let disposed = false
  let active = false
  let pending: keyof typeof handlers | null = null
  const unlisteners: Unlisten[] = []
  const release = (unlisten: Unlisten) => {
    try {
      void Promise.resolve(unlisten()).catch(() => console.warn("[ws] native lifecycle cleanup failed"))
    } catch {
      console.warn("[ws] native lifecycle cleanup failed")
    }
  }
  const dispose = () => {
    disposed = true
    active = false
    pending = null
    for (const unlisten of unlisteners.splice(0)) release(unlisten)
  }
  const deliver = (name: keyof typeof handlers) => {
    if (disposed) return
    if (!active) { pending = name; return }
    try { handlers[name]() } catch {
      console.warn("[ws] native lifecycle callback failed", { event: name })
    }
  }
  const fail = (name: keyof typeof handlers) => {
    if (disposed) return
    dispose()
    console.warn("[ws] native lifecycle listener unavailable", { event: name })
  }
  for (const name of ["resumed", "suspended"] as const) {
    if (disposed) break
    try {
      void current.listen(`tauri://${name}`, () => deliver(name)).then((unlisten) => {
        if (disposed) release(unlisten)
        else {
          unlisteners.push(unlisten)
          if (unlisteners.length === 2) {
            active = true
            const latest = pending
            pending = null
            if (latest) deliver(latest)
          }
        }
      }, () => fail(name))
    } catch {
      fail(name)
    }
  }
  return dispose
}
