export type PlayerRotation = -90 | 0 | 90
type Point = { clientX: number; clientY: number }
type Bounds = { left: number; top: number; width: number; height: number }

export function playerPointerFraction(point: Point, bounds: Bounds, rotation: PlayerRotation): number {
  const value = rotation === 0 ? (point.clientX - bounds.left) / bounds.width
    : rotation === 90 ? (point.clientY - bounds.top) / bounds.height
      : 1 - (point.clientY - bounds.top) / bounds.height
  return Number.isFinite(value) ? value : 0
}

export function playerPointerRegion(point: Point, bounds: Bounds, rotation: PlayerRotation): "left" | "center" | "right" {
  const fraction = playerPointerFraction(point, bounds, rotation)
  return fraction < 1 / 3 ? "left" : fraction >= 2 / 3 ? "right" : "center"
}

export function projectSliderPointer<T extends Point & { type: string; currentTarget: EventTarget | null }>(event: T, rotation: PlayerRotation): T {
  if (rotation === 0 || !(event.currentTarget instanceof HTMLElement)) return event
  const bounds = event.currentTarget.getBoundingClientRect()
  const clientX = bounds.left + playerPointerFraction(event, bounds, rotation) * bounds.width
  const cross = rotation === 90 ? 1 - (event.clientX - bounds.left) / bounds.width : (event.clientX - bounds.left) / bounds.width
  const clientY = event.type === "pointerup" ? bounds.top + cross * bounds.height : event.clientY
  return new Proxy(event, {
    get(target, property) {
      if (property === "clientX") return clientX
      if (property === "clientY") return clientY
      const value = Reflect.get(target, property, target) as unknown
      return typeof value === "function" ? value.bind(target) : value
    },
  })
}

export function playerRelativeRotation(physicalAngle: number, interfaceAngle: number): PlayerRotation {
  const angle = ((interfaceAngle - physicalAngle) % 360 + 360) % 360
  return angle === 90 ? 90 : angle === 270 ? -90 : 0
}
