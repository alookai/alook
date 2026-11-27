import { isMobile, tauriInvoke } from "@alook/shared"

type LifecycleEvent = "resumed" | "suspended"
type LifecycleHandlers = { resumed: () => void; suspended: () => void }
type TauriChannel = { onmessage: (payload?: unknown) => void }
type LifecycleWindow = Window & {
  __TAURI__?: { core?: { Channel?: new () => TauriChannel } }
}
type ListenResponse = { registrationId: number; suspended: boolean }

type Subscriber = {
  handlers: LifecycleHandlers
  active: boolean
}

const hub: {
  windowRef: Window | null
  status: "idle" | "connecting" | "connected"
  registrationId: number | null
  suspended: boolean
  pending: LifecycleEvent | null
  generation: number
  subscribers: Set<Subscriber>
} = {
  windowRef: null,
  status: "idle",
  registrationId: null,
  suspended: false,
  pending: null,
  generation: 0,
  subscribers: new Set(),
}

function resetHubForNewWindow(currentWindow: Window): void {
  if (hub.windowRef === currentWindow) return
  hub.windowRef = currentWindow
  hub.generation += 1
  hub.status = "idle"
  hub.registrationId = null
  hub.suspended = false
  hub.pending = null
  for (const subscriber of hub.subscribers) subscriber.active = false
  hub.subscribers.clear()
}

function invokeUnlisten(registrationId: number): void {
  try {
    void tauriInvoke("window_lifecycle_unlisten", { registrationId }).catch(() => {
      console.warn("[ws] native lifecycle cleanup failed")
    })
  } catch {
    console.warn("[ws] native lifecycle cleanup failed")
  }
}

function deliverToSubscriber(subscriber: Subscriber, event: LifecycleEvent): void {
  if (!subscriber.active) return
  try {
    subscriber.handlers[event]()
  } catch {
    console.warn("[ws] native lifecycle callback failed", { event })
  }
}

function deliverToAll(event: LifecycleEvent): void {
  for (const subscriber of [...hub.subscribers]) {
    deliverToSubscriber(subscriber, event)
  }
}

function teardownHub(): void {
  const registrationId = hub.registrationId
  hub.generation += 1
  hub.status = "idle"
  hub.registrationId = null
  hub.suspended = false
  hub.pending = null
  if (registrationId !== null) invokeUnlisten(registrationId)
}

function failHub(): void {
  for (const subscriber of hub.subscribers) subscriber.active = false
  hub.subscribers.clear()
  teardownHub()
  console.warn("[ws] native lifecycle listener unavailable")
}

function startNativeChannel(): boolean {
  let ChannelCtor: (new () => TauriChannel) | undefined
  try {
    ChannelCtor = (window as LifecycleWindow).__TAURI__?.core?.Channel
  } catch {
    console.warn("[ws] native lifecycle bridge unavailable")
    return false
  }
  if (!ChannelCtor) {
    console.warn("[ws] native lifecycle bridge unavailable")
    return false
  }

  let channel: TauriChannel
  try {
    channel = new ChannelCtor()
  } catch {
    console.warn("[ws] native lifecycle bridge unavailable")
    return false
  }

  const generation = ++hub.generation
  hub.status = "connecting"
  hub.registrationId = null
  hub.suspended = false
  hub.pending = null

  channel.onmessage = (payload?: unknown) => {
    if (generation !== hub.generation) return
    if (payload !== "resumed" && payload !== "suspended") return
    if (hub.status === "connecting") {
      hub.pending = payload
      return
    }
    if (hub.status !== "connected") return
    hub.suspended = payload === "suspended"
    deliverToAll(payload)
  }

  try {
    void tauriInvoke<ListenResponse>("window_lifecycle_listen", { channel }).then(
      (result) => {
        const valid = typeof result?.registrationId === "number"
          && Number.isSafeInteger(result.registrationId)
          && typeof result?.suspended === "boolean"
        if (!valid) {
          if (generation === hub.generation) failHub()
          return
        }
        if (generation !== hub.generation || hub.subscribers.size === 0) {
          invokeUnlisten(result.registrationId)
          return
        }
        hub.status = "connected"
        hub.registrationId = result.registrationId
        const pending = hub.pending
        hub.pending = null
        if (pending !== null) {
          hub.suspended = pending === "suspended"
          deliverToAll(pending)
        } else {
          hub.suspended = result.suspended
          if (hub.suspended) deliverToAll("suspended")
        }
      },
      () => {
        if (generation === hub.generation) failHub()
      },
    )
  } catch {
    if (generation === hub.generation) failHub()
    return false
  }
  return true
}

export function listenNativeWindowLifecycle(handlers: LifecycleHandlers): () => void {
  if (typeof window === "undefined" || !isMobile()) return () => undefined
  resetHubForNewWindow(window)

  const subscriber: Subscriber = { handlers, active: true }
  hub.subscribers.add(subscriber)

  if (hub.status === "idle") {
    if (!startNativeChannel()) {
      subscriber.active = false
      hub.subscribers.delete(subscriber)
      return () => undefined
    }
  } else if (hub.status === "connected" && hub.suspended) {
    deliverToSubscriber(subscriber, "suspended")
  }

  return () => {
    if (!subscriber.active) return
    subscriber.active = false
    hub.subscribers.delete(subscriber)
    if (hub.subscribers.size === 0 && hub.status !== "idle") {
      teardownHub()
    }
  }
}
