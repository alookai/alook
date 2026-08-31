import { createElement, type ReactElement, type ReactNode } from "react"
import TestRenderer, { act } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const policy = vi.hoisted(() => ({ disposition: vi.fn() }))

vi.mock("@/components/authenticated-context-menu-boundary", () => ({
  useAuthenticatedContextMenuPolicy: () => policy,
}))

vi.mock("@base-ui/react/context-menu", async () => {
  const ReactModule = await import("react")
  return {
    ContextMenu: {
      Root: ({ children, ...props }: { children?: ReactNode }) =>
        ReactModule.createElement("mock-context-root", props, children),
      Trigger: ({ render, children, ...props }: { render?: ReactElement; children?: ReactNode }) =>
        ReactModule.cloneElement(render ?? ReactModule.createElement("div"), props, children),
      Portal: ({ children }: { children?: ReactNode }) =>
        ReactModule.createElement("mock-portal", null, children),
      Positioner: ({ children }: { children?: ReactNode }) =>
        ReactModule.createElement("mock-positioner", null, children),
      Popup: ({ children }: { children?: ReactNode }) =>
        ReactModule.createElement("mock-popup", null, children),
    },
  }
})

import {
  ContextMenu,
  ContextMenuTrigger,
  isKeyboardContextMenu,
  isSecondaryContextPointer,
  nativeContextGestureMatches,
} from "./context-menu"

type Listener = EventListenerOrEventListenerObject

function pointerEvent({
  pointerId = 1,
  button = 2,
  ctrlKey = false,
  clientX = 20,
  clientY = 30,
}: {
  pointerId?: number
  button?: number
  ctrlKey?: boolean
  clientX?: number
  clientY?: number
} = {}) {
  return {
    pointerId,
    pointerType: "mouse",
    button,
    ctrlKey,
    clientX,
    clientY,
    timeStamp: 100,
  } as PointerEvent
}

function triggerTree(disabled = false, id = "trigger") {
  return createElement(
    ContextMenu,
    { disabled },
    createElement(ContextMenuTrigger, {
      render: createElement("button", { id }),
    }),
  )
}

function handlers(renderer: TestRenderer.ReactTestRenderer) {
  const root = renderer.root.findByType("mock-context-root")
  const trigger = renderer.root.findByType("button")
  return { root, trigger }
}

function syntheticPointer(nativeEvent: PointerEvent, currentTarget: EventTarget) {
  return { nativeEvent, currentTarget }
}

function syntheticContext(nativeEvent: PointerEvent, currentTarget: EventTarget) {
  return {
    nativeEvent,
    currentTarget,
    preventBaseUIHandler: vi.fn(),
  }
}

describe("ContextMenu native gesture bypass", () => {
  const listeners = new Map<string, Set<Listener>>()
  const addEventListener = vi.fn((type: string, listener: Listener) => {
    const current = listeners.get(type) ?? new Set()
    current.add(listener)
    listeners.set(type, current)
  })
  const removeEventListener = vi.fn((type: string, listener: Listener) => {
    listeners.get(type)?.delete(listener)
  })

  beforeEach(() => {
    policy.disposition.mockReset()
    listeners.clear()
    addEventListener.mockClear()
    removeEventListener.mockClear()
    vi.stubGlobal("window", { addEventListener, removeEventListener })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("recognizes right-click and control-click only", () => {
    expect(isSecondaryContextPointer({ button: 2, ctrlKey: false } as MouseEvent)).toBe(true)
    expect(isSecondaryContextPointer({ button: 0, ctrlKey: true } as MouseEvent)).toBe(true)
    expect(isSecondaryContextPointer({ button: 0, ctrlKey: false } as MouseEvent)).toBe(false)
    expect(isSecondaryContextPointer({ button: 1, ctrlKey: false } as MouseEvent)).toBe(false)
  })

  it("recognizes the keyboard menu key and Shift+F10 only", () => {
    expect(isKeyboardContextMenu({ key: "ContextMenu", shiftKey: false } as KeyboardEvent)).toBe(true)
    expect(isKeyboardContextMenu({ key: "F10", shiftKey: true } as KeyboardEvent)).toBe(true)
    expect(isKeyboardContextMenu({ key: "F10", shiftKey: false } as KeyboardEvent)).toBe(false)
    expect(isKeyboardContextMenu({ key: "Enter", shiftKey: true } as KeyboardEvent)).toBe(false)
  })

  it("routes keyboard activation through contextmenu without overriding caller cancellation", async () => {
    policy.disposition.mockReturnValue("product")
    const dispatched: Event[] = []
    const source = {
      dispatchEvent: vi.fn((event: Event) => {
        dispatched.push(event)
        return true
      }),
      getBoundingClientRect: () => ({ left: 10, top: 20, width: 40, height: 20 }),
    }
    class ContextEvent {
      type: string
      bubbles: boolean
      cancelable: boolean
      button: number
      clientX: number
      clientY: number

      constructor(type: string, init: MouseEventInit) {
        this.type = type
        this.bubbles = init.bubbles ?? false
        this.cancelable = init.cancelable ?? false
        this.button = init.button ?? 0
        this.clientX = init.clientX ?? 0
        this.clientY = init.clientY ?? 0
      }
    }
    vi.stubGlobal("MouseEvent", ContextEvent)
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(triggerTree())
    })
    const preventDefault = vi.fn()
    handlers(renderer).trigger.props.onKeyDown({
      currentTarget: source,
      defaultPrevented: false,
      nativeEvent: { key: "F10", shiftKey: true },
      preventDefault,
    })
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(source.dispatchEvent).toHaveBeenCalledOnce()
    expect(dispatched[0]).toMatchObject({
      type: "contextmenu",
      bubbles: true,
      cancelable: true,
      button: 2,
      clientX: 30,
      clientY: 30,
    })

    const callerCancelled = vi.fn((event: { preventDefault(): void }) => event.preventDefault())
    await act(async () => {
      renderer.update(createElement(
        ContextMenu,
        null,
        createElement(ContextMenuTrigger, {
          onKeyDown: callerCancelled,
          render: createElement("button", { id: "trigger" }),
        }),
      ))
    })
    const cancelledEvent = {
      currentTarget: source,
      defaultPrevented: false,
      nativeEvent: { key: "ContextMenu", shiftKey: false },
      preventDefault() {
        this.defaultPrevented = true
      },
    }
    handlers(renderer).trigger.props.onKeyDown(cancelledEvent)
    expect(callerCancelled).toHaveBeenCalledOnce()
    expect(source.dispatchEvent).toHaveBeenCalledOnce()
    await act(async () => renderer.unmount())
  })

  it("matches source and pointer identity with a MouseEvent fallback", () => {
    const source = {}
    const gesture = {
      token: 1,
      source,
      pointerId: 7,
      pointerType: "mouse",
      button: 2,
      ctrlKey: false,
      startedAt: 1,
      clientX: 2,
      clientY: 3,
    }
    expect(nativeContextGestureMatches(gesture, pointerEvent({ pointerId: 7 }), source)).toBe(true)
    expect(nativeContextGestureMatches(gesture, pointerEvent({ pointerId: 8 }), source)).toBe(false)
    expect(nativeContextGestureMatches(gesture, pointerEvent({ pointerId: 7 }), {})).toBe(false)
    expect(nativeContextGestureMatches(
      { ...gesture, pointerId: null },
      { button: 2, ctrlKey: false } as MouseEvent,
      source,
    )).toBe(true)
  })

  it("disables for one matching native gesture and restores the next custom gesture", async () => {
    policy.disposition.mockReturnValue("native")
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(triggerTree())
    })
    const source = {}
    const nativeEvent = pointerEvent()
    await act(async () => {
      handlers(renderer).trigger.props.onPointerDownCapture(syntheticPointer(nativeEvent, source))
    })
    expect(handlers(renderer).root.props.disabled).toBe(true)

    const contextEvent = syntheticContext(nativeEvent, source)
    await act(async () => {
      handlers(renderer).trigger.props.onContextMenu(contextEvent)
    })
    expect(contextEvent.preventBaseUIHandler).toHaveBeenCalledOnce()
    expect(handlers(renderer).root.props.disabled).toBe(false)

    policy.disposition.mockReturnValue("product")
    const nextContext = syntheticContext(pointerEvent(), source)
    await act(async () => {
      handlers(renderer).trigger.props.onPointerDownCapture(syntheticPointer(pointerEvent(), source))
      handlers(renderer).trigger.props.onContextMenu(nextContext)
    })
    expect(nextContext.preventBaseUIHandler).not.toHaveBeenCalled()
    expect(handlers(renderer).root.props.disabled).toBe(false)
    await act(async () => renderer.unmount())
  })

  it("clears a stale arm on mismatched contextmenu without consuming it", async () => {
    policy.disposition.mockReturnValue("native")
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(triggerTree())
    })
    const source = {}
    await act(async () => {
      handlers(renderer).trigger.props.onPointerDownCapture(
        syntheticPointer(pointerEvent({ pointerId: 1 }), source),
      )
    })
    const mismatch = syntheticContext(pointerEvent({ pointerId: 2 }), source)
    await act(async () => handlers(renderer).trigger.props.onContextMenu(mismatch))
    expect(mismatch.preventBaseUIHandler).not.toHaveBeenCalled()
    expect(handlers(renderer).root.props.disabled).toBe(false)
    await act(async () => renderer.unmount())
  })

  it("keeps a different trigger root enabled while another root is armed", async () => {
    policy.disposition.mockReturnValue("native")
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(createElement(
        "section",
        null,
        triggerTree(false, "first"),
        triggerTree(false, "second"),
      ))
    })
    const roots = renderer.root.findAllByType("mock-context-root")
    const triggers = renderer.root.findAllByType("button")
    const firstSource = {}
    await act(async () => {
      triggers[0]!.props.onPointerDownCapture(syntheticPointer(pointerEvent(), firstSource))
    })
    expect(roots[0]!.props.disabled).toBe(true)
    expect(roots[1]!.props.disabled).toBe(false)

    policy.disposition.mockReturnValue("product")
    const secondContext = syntheticContext(pointerEvent(), {})
    await act(async () => triggers[1]!.props.onContextMenu(secondContext))
    expect(secondContext.preventBaseUIHandler).not.toHaveBeenCalled()
    expect(roots[1]!.props.disabled).toBe(false)

    await act(async () => triggers[0]!.props.onPointerLeave({ currentTarget: firstSource }))
    expect(roots[0]!.props.disabled).toBe(false)
    await act(async () => renderer.unmount())
  })

  it.each(["pointerup", "pointercancel"])("clears on matching global %s", async (type) => {
    policy.disposition.mockReturnValue("native")
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(triggerTree())
    })
    await act(async () => {
      handlers(renderer).trigger.props.onPointerDownCapture(
        syntheticPointer(pointerEvent({ pointerId: 4 }), {}),
      )
    })
    expect(handlers(renderer).root.props.disabled).toBe(true)
    const listener = [...(listeners.get(type) ?? [])][0] as EventListener
    await act(async () => listener(pointerEvent({ pointerId: 4 })))
    expect(handlers(renderer).root.props.disabled).toBe(false)
    await act(async () => renderer.unmount())
  })

  it("clears on pointer leave and blur", async () => {
    policy.disposition.mockReturnValue("native")
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(triggerTree())
    })
    const source = {}
    await act(async () => {
      handlers(renderer).trigger.props.onPointerDownCapture(syntheticPointer(pointerEvent(), source))
      handlers(renderer).trigger.props.onPointerLeave({ currentTarget: source })
    })
    expect(handlers(renderer).root.props.disabled).toBe(false)

    await act(async () => {
      handlers(renderer).trigger.props.onPointerDownCapture(syntheticPointer(pointerEvent(), source))
    })
    const blur = [...(listeners.get("blur") ?? [])][0] as EventListener
    await act(async () => blur({} as Event))
    expect(handlers(renderer).root.props.disabled).toBe(false)
    await act(async () => renderer.unmount())
  })

  it("fences a late cleanup from an older replaced gesture", async () => {
    policy.disposition.mockReturnValue("native")
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(triggerTree())
    })
    const source = {}
    await act(async () => {
      handlers(renderer).trigger.props.onPointerDownCapture(
        syntheticPointer(pointerEvent({ pointerId: 1 }), source),
      )
    })
    const stalePointerUp = [...(listeners.get("pointerup") ?? [])][0] as EventListener
    await act(async () => {
      handlers(renderer).trigger.props.onPointerDownCapture(
        syntheticPointer(pointerEvent({ pointerId: 2 }), source),
      )
    })
    await act(async () => stalePointerUp(pointerEvent({ pointerId: 1 })))
    expect(handlers(renderer).root.props.disabled).toBe(true)

    const currentPointerUp = [...(listeners.get("pointerup") ?? [])][0] as EventListener
    await act(async () => currentPointerUp(pointerEvent({ pointerId: 2 })))
    expect(handlers(renderer).root.props.disabled).toBe(false)
    await act(async () => renderer.unmount())
  })

  it("never overrides caller disabled ownership", async () => {
    policy.disposition.mockReturnValue("native")
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(triggerTree(true))
    })
    const source = {}
    await act(async () => {
      handlers(renderer).trigger.props.onPointerDownCapture(syntheticPointer(pointerEvent(), source))
    })
    expect(handlers(renderer).root.props.disabled).toBe(true)
    expect(policy.disposition).not.toHaveBeenCalled()

    await act(async () => renderer.update(triggerTree(false)))
    expect(handlers(renderer).root.props.disabled).toBe(false)
    await act(async () => renderer.unmount())
  })

  it("removes armed global cleanup listeners on unmount", async () => {
    policy.disposition.mockReturnValue("native")
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(triggerTree())
    })
    await act(async () => {
      handlers(renderer).trigger.props.onPointerDownCapture(syntheticPointer(pointerEvent(), {}))
    })
    expect(listeners.get("pointerup")?.size).toBe(1)
    expect(listeners.get("pointercancel")?.size).toBe(1)
    expect(listeners.get("blur")?.size).toBe(1)
    await act(async () => renderer.unmount())
    expect(listeners.get("pointerup")?.size).toBe(0)
    expect(listeners.get("pointercancel")?.size).toBe(0)
    expect(listeners.get("blur")?.size).toBe(0)
  })
})
