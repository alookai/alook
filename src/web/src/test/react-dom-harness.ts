import userEvent from "@testing-library/user-event"

export {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
export type {
  RenderHookOptions,
  RenderHookResult,
  RenderOptions,
  RenderResult,
} from "@testing-library/react"

export function setupUser(options?: Parameters<typeof userEvent.setup>[0]) {
  return userEvent.setup(options)
}

type RectInput = {
  bottom?: number
  height?: number
  left?: number
  right?: number
  top?: number
  width?: number
  x?: number
  y?: number
}

type ElementGeometry = RectInput & {
  clientHeight?: number
  clientWidth?: number
  offsetHeight?: number
  offsetWidth?: number
  scrollHeight?: number
  scrollLeft?: number
  scrollTop?: number
  scrollWidth?: number
}

export function mockElementGeometry(
  element: HTMLElement,
  geometry: ElementGeometry,
): () => void {
  const originals = new Map<string, PropertyDescriptor | undefined>()
  const define = (property: string, value: unknown) => {
    originals.set(property, Object.getOwnPropertyDescriptor(element, property))
    Object.defineProperty(element, property, {
      configurable: true,
      value,
      writable: true,
    })
  }

  for (const property of [
    "clientHeight",
    "clientWidth",
    "offsetHeight",
    "offsetWidth",
    "scrollHeight",
    "scrollLeft",
    "scrollTop",
    "scrollWidth",
  ] as const) {
    if (geometry[property] !== undefined) define(property, geometry[property])
  }

  const hasRect = ["bottom", "height", "left", "right", "top", "width", "x", "y"]
    .some((property) => geometry[property as keyof RectInput] !== undefined)
  if (hasRect) {
    const left = geometry.left ?? geometry.x ?? 0
    const top = geometry.top ?? geometry.y ?? 0
    const width = geometry.width ?? Math.max(0, (geometry.right ?? left) - left)
    const height = geometry.height ?? Math.max(0, (geometry.bottom ?? top) - top)
    const rect = {
      bottom: geometry.bottom ?? top + height,
      height,
      left,
      right: geometry.right ?? left + width,
      top,
      width,
      x: geometry.x ?? left,
      y: geometry.y ?? top,
      toJSON: () => ({}),
    }
    define("getBoundingClientRect", () => rect)
  }

  return () => {
    for (const [property, descriptor] of originals) {
      if (descriptor) Object.defineProperty(element, property, descriptor)
      else delete (element as unknown as Record<string, unknown>)[property]
    }
  }
}
