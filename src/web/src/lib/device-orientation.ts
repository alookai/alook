import { getClientPlatform, isTauri } from "@alook/shared"
import { listenNativeWindowLifecycle } from "./native-window-lifecycle"
import { isQuarterTurn, listenNativeDeviceOrientation, type DeviceDirection, type QuarterTurn } from "./native-device-orientation"

type PermissionEvent = typeof DeviceOrientationEvent & { requestPermission?: (absolute?: boolean) => Promise<PermissionState> }
type SensorWindow = Window & { DeviceOrientationEvent?: PermissionEvent }

export function coarseDeviceAngle(degrees: number, previous: QuarterTurn | null): QuarterTurn | null {
  if (!Number.isFinite(degrees)) return previous
  const value = ((degrees % 360) + 360) % 360
  if (previous !== null) {
    const distance = Math.abs(value - previous)
    if (Math.min(distance, 360 - distance) < 60) return previous
  }
  return (Math.round(value / 90) * 90) % 360 as QuarterTurn
}

export function deviceAngleFromTilt(beta: number | null, gamma: number | null, previous: QuarterTurn | null): QuarterTurn | null {
  if (beta === null || gamma === null || !Number.isFinite(beta) || !Number.isFinite(gamma)
    || beta < -180 || beta >= 180 || gamma < -90 || gamma >= 90) return previous
  const b = beta * Math.PI / 180
  const g = gamma * Math.PI / 180
  const x = Math.cos(b) * Math.sin(g)
  const y = -Math.sin(b)
  return Math.hypot(x, y) < 0.5 ? previous : coarseDeviceAngle(Math.atan2(x, -y) * 180 / Math.PI, previous)
}

export function browserInterfaceAngle(): QuarterTurn | null {
  const raw = window.screen?.orientation?.angle
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null
  const angle = ((-raw % 360) + 360) % 360
  return isQuarterTurn(angle) ? angle : null
}

function requestProviderPermission(): Promise<"granted" | "denied" | "unavailable"> {
  if (getClientPlatform() !== "mobile") return Promise.resolve("unavailable")
  if (isTauri()) return Promise.resolve("granted")
  const sensor = (window as SensorWindow).DeviceOrientationEvent
  if (!window.isSecureContext || !sensor || browserInterfaceAngle() === null) return Promise.resolve("unavailable")
  try {
    return sensor.requestPermission
      ? sensor.requestPermission(false).then(value => value === "granted" ? "granted" : "denied", () => "denied")
      : Promise.resolve("granted")
  } catch { return Promise.resolve("denied") }
}

export function listenBrowserDeviceOrientation(changed: (value: DeviceDirection) => void): () => void {
  let disposed = false
  let physicalAngle: QuarterTurn | null = null
  const publish = () => {
    const interfaceAngle = browserInterfaceAngle()
    if (!disposed && interfaceAngle !== null) changed({ availability: "available", physicalAngle, interfaceAngle })
  }
  const orientation = (event: DeviceOrientationEvent) => {
    if (disposed) return
    physicalAngle = deviceAngleFromTilt(event.beta, event.gamma, physicalAngle)
    publish()
  }
  window.addEventListener("deviceorientation", orientation)
  window.addEventListener("orientationchange", publish)
  window.screen?.orientation?.addEventListener?.("change", publish)
  return () => {
    disposed = true
    window.removeEventListener("deviceorientation", orientation)
    window.removeEventListener("orientationchange", publish)
    window.screen?.orientation?.removeEventListener?.("change", publish)
  }
}

const emptyDirection: DeviceDirection = { availability: "unavailable", physicalAngle: null, interfaceAngle: 0 }

export function createDeviceOrientationService() {
  let snapshot = emptyDirection
  let granted = false
  let permissionRequest: Promise<boolean> | undefined
  let suspended = false
  let version = 0
  let lifetime = 0
  let stopSampling: (() => void) | undefined
  let stopLifecycle: (() => void) | undefined
  const listeners = new Set<() => void>()
  const publish = (next: DeviceDirection) => {
    if (next.availability === snapshot.availability && next.physicalAngle === snapshot.physicalAngle && next.interfaceAngle === snapshot.interfaceAngle) return
    snapshot = next
    for (const notify of listeners) notify()
  }
  const retire = () => {
    version += 1
    stopSampling?.()
    stopSampling = undefined
  }
  const reconcile = () => {
    if (!listeners.size || !granted || suspended || document.hidden) {
      retire()
      publish({ ...snapshot, availability: snapshot.availability === "denied" ? "denied" : "unavailable" })
      return
    }
    if (stopSampling) return
    const current = ++version
    const deliver = (value: DeviceDirection) => {
      if (!listeners.size || current !== version || suspended || document.hidden) return
      if (value.availability === "denied") { granted = false; retire() }
      publish(value)
    }
    try {
      const release = isTauri() ? listenNativeDeviceOrientation(deliver) : listenBrowserDeviceOrientation(deliver)
      if (current !== version || !listeners.size || !granted) release()
      else stopSampling = release
    } catch { publish({ ...snapshot, availability: "unavailable" }) }
  }
  const requestPermission = () => {
    if (granted) return Promise.resolve(true)
    if (permissionRequest) return permissionRequest
    permissionRequest = requestProviderPermission().then(outcome => {
      granted = outcome === "granted"
      permissionRequest = undefined
      if (!granted) publish({ ...snapshot, availability: outcome === "denied" ? "denied" : "unavailable" })
      reconcile()
      return granted
    })
    return permissionRequest
  }
  const subscribe = (notify: () => void) => {
    const listener = () => notify()
    listeners.add(listener)
    if (listeners.size === 1) {
      const current = ++lifetime
      suspended = false
      const suspend = () => { if (current === lifetime) { suspended = true; reconcile() } }
      const resume = () => { if (current === lifetime) { suspended = false; reconcile() } }
      const visibility = () => { if (current === lifetime) reconcile() }
      const stopNative = isTauri() ? listenNativeWindowLifecycle({ suspended: suspend, resumed: resume }) : () => undefined
      document.addEventListener("visibilitychange", visibility)
      window.addEventListener("pagehide", suspend)
      window.addEventListener("pageshow", resume)
      stopLifecycle = () => {
        stopNative()
        document.removeEventListener("visibilitychange", visibility)
        window.removeEventListener("pagehide", suspend)
        window.removeEventListener("pageshow", resume)
      }
      reconcile()
    }
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      listeners.delete(listener)
      if (listeners.size) return
      lifetime += 1
      retire()
      stopLifecycle?.()
      stopLifecycle = undefined
      snapshot = snapshot.availability === "denied" ? { ...emptyDirection, availability: "denied" } : emptyDirection
    }
  }
  return { getSnapshot: () => snapshot, getServerSnapshot: () => emptyDirection, subscribe, requestPermission }
}

export const deviceOrientation = createDeviceOrientationService()
