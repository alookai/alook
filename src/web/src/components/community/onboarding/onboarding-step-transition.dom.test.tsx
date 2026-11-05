import { useEffect } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { act, render, screen } from "@/test/react-dom-harness"
import { StepSlide } from "@/components/ui/step-slide"

const animations: { onfinish: (() => void) | null; cancel: ReturnType<typeof vi.fn> }[] = []
function motion(reduced = false) {
  animations.length = 0
  vi.stubGlobal("matchMedia", () => ({ matches: reduced, addEventListener() {}, removeEventListener() {} }))
  const animate = vi.fn<HTMLElement["animate"]>(() => {
    const animation = { onfinish: null, cancel: vi.fn(), pause: vi.fn() }
    animations.push(animation)
    return animation as unknown as Animation
  })
  Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, value: animate })
  return animate
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); Reflect.deleteProperty(HTMLElement.prototype, "animate") })

it("slides both ways, locks incoming controls, and never mounts an extra live step", () => {
  const animate = motion()
  const mount = vi.fn()
  function Step({ name }: { name: string }) {
    useEffect(() => { mount(name) }, [name])
    return <><h2>{name}</h2><button>{name} action</button></>
  }
  const view = render(<StepSlide testId="onboarding-step-transition" step="first" order={0}><Step name="First" /></StepSlide>)
  screen.getByRole("button").focus()
  view.rerender(<StepSlide testId="onboarding-step-transition" step="second" order={1}><Step name="Second" /></StepSlide>)
  const viewport = screen.getByTestId("onboarding-step-transition")
  expect(viewport).toHaveAttribute("data-transitioning", "true")
  expect((viewport.firstElementChild as HTMLElement).inert).toBe(true)
  expect(mount.mock.calls).toEqual([["First"], ["Second"]])
  expect(animate.mock.calls[0][0]).toEqual([{ transform: "translateX(100%)" }, { transform: "translateX(0)" }])
  act(() => { animations[0].onfinish?.() })
  expect(viewport.children).toHaveLength(1)
  expect((viewport.firstElementChild as HTMLElement).inert).toBe(false)
  expect(screen.getByRole("heading", { name: "Second" })).toHaveFocus()
  view.rerender(<StepSlide testId="onboarding-step-transition" step="first" order={0}><Step name="First" /></StepSlide>)
  expect(animate.mock.calls[2][0]).toEqual([{ transform: "translateX(-100%)" }, { transform: "translateX(0)" }])
  view.unmount()
  expect(animations.every(animation => animation.cancel.mock.calls.length === 1)).toBe(true)
})

describe("motion preferences and interrupted steps", () => {
  it("switches immediately for reduced motion", () => {
    const animate = motion(true)
    const view = render(<StepSlide testId="onboarding-step-transition" step="a" order={0}><button>First</button></StepSlide>)
    screen.getByRole("button").focus()
    view.rerender(<StepSlide testId="onboarding-step-transition" step="b" order={1}><h2>Second</h2></StepSlide>)
    expect(screen.getByRole("heading")).toHaveFocus()
    expect(animate).not.toHaveBeenCalled()
    expect(screen.getByTestId("onboarding-step-transition").children).toHaveLength(1)
    expect(screen.getByText("Second")).toBeInTheDocument()
  })
  it("cleans the previous visual snapshot when another step replaces it", () => {
    motion()
    const view = render(<StepSlide testId="onboarding-step-transition" step="a" order={0}>First</StepSlide>)
    view.rerender(<StepSlide testId="onboarding-step-transition" step="b" order={1}>Second</StepSlide>)
    view.rerender(<StepSlide testId="onboarding-step-transition" step="c" order={2}>Third</StepSlide>)
    expect(screen.queryByText("First")).toBeNull()
    expect(screen.getByTestId("onboarding-step-transition").children).toHaveLength(2)
    expect(animations.slice(0, 2).every(animation => animation.cancel.mock.calls.length === 1)).toBe(true)
    act(() => { animations[2].onfinish?.() })
    expect(screen.getByTestId("onboarding-step-transition").children).toHaveLength(1)
  })
})

it("retargets late content height without cancelling it when the horizontal slide ends", () => {
  const animate = motion()
  let contentHeight = 100
  let viewportHeight = 100
  let notifyResize: () => void = () => {}
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { notifyResize = callback }
    observe() {}
    disconnect() {}
  })
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function(this: HTMLElement) {
    return new DOMRect(0, 0, 300, this.dataset.testid === "slide" ? viewportHeight : contentHeight)
  })
  const view = render(<StepSlide testId="slide" step="first" order={0}>First</StepSlide>)
  contentHeight = 200
  view.rerender(<StepSlide testId="slide" step="second" order={1}>Second</StepSlide>)
  expect(animate.mock.calls[0][0]).toEqual([{ height: "100px" }, { height: "200px" }])
  viewportHeight = 140
  contentHeight = 260
  act(() => notifyResize())
  expect(animate.mock.calls[3][0]).toEqual([{ height: "140px" }, { height: "260px" }])
  expect(animations[0].cancel).toHaveBeenCalledOnce()
  act(() => animations[1].onfinish?.())
  expect(animations[3].cancel).not.toHaveBeenCalled()
  expect(screen.getByTestId("slide")).toHaveStyle({ height: "260px" })
  act(() => animations[3].onfinish?.())
  expect(animations[3].cancel).toHaveBeenCalledOnce()
  expect(screen.getByTestId("slide")).toHaveStyle({ height: "260px" })
})
