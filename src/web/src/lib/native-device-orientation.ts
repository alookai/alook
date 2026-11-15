import { tauriInvoke } from "@alook/shared"

export type QuarterTurn = 0 | 90 | 180 | 270
type DirectionAvailability = "available" | "unavailable" | "denied"
export type DeviceDirection = Readonly<{ availability: DirectionAvailability; physicalAngle: QuarterTurn | null; interfaceAngle: QuarterTurn }>
type NativeChannel = { onmessage: (value: unknown) => void }
type OrientationWindow = Window & { __TAURI__?: { core?: { Channel?: new () => NativeChannel } } }

export function isQuarterTurn(value: unknown): value is QuarterTurn {
  return value === 0 || value === 90 || value === 180 || value === 270
}

export function parseDeviceDirection(value: unknown): DeviceDirection | null {
  if (!value || typeof value !== "object") return null
  if (!("availability" in value) || (value.availability !== "available" && value.availability !== "unavailable" && value.availability !== "denied")
    || !("physicalAngle" in value) || (value.physicalAngle !== null && !isQuarterTurn(value.physicalAngle))
    || !("interfaceAngle" in value) || !isQuarterTurn(value.interfaceAngle)) return null
  return { availability: value.availability, physicalAngle: value.physicalAngle, interfaceAngle: value.interfaceAngle }
}

export function listenNativeDeviceOrientation(changed: (value: DeviceDirection) => void): () => void {
  const Channel = (window as OrientationWindow).__TAURI__?.core?.Channel
  if (!Channel) return () => undefined
  let disposed = false
  let registrationId: number | undefined
  const channel = new Channel()
  channel.onmessage = value => {
    if (disposed) return
    const sample = parseDeviceDirection(value)
    if (sample) changed(sample)
  }
  const release = (id: number) => {
    void tauriInvoke("mobile_orientation_unlisten", { registrationId: id }).catch(() => undefined)
  }
  void tauriInvoke<number>("mobile_orientation_listen", { channel }).then(id => {
    if (!Number.isSafeInteger(id) || id <= 0) { disposed = true; return }
    if (disposed) release(id)
    else registrationId = id
  }, () => { disposed = true })
  return () => {
    disposed = true
    channel.onmessage = () => undefined
    if (registrationId !== undefined) release(registrationId)
    registrationId = undefined
  }
}
