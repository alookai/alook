import { createRef } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render } from "@/test/react-dom-harness"

const animation = vi.hoisted(() => ({
  controls: { start: vi.fn<(state: string) => Promise<void>>(() => Promise.resolve()) },
  reduced: false,
}))

vi.mock("motion/react", async (original) => ({
  ...await original<typeof import("motion/react")>(),
  useAnimation: () => animation.controls,
}))

vi.mock("@/hooks/use-reduced-motion", () => ({ useReducedMotion: () => animation.reduced }))

import { createAnimatedIcon } from "./animated-icon"
import { Button } from "@/components/ui/button"
import { Check, CheckIcon, Loader2, LoaderCircleIcon, CircleHelp, HelpCircle } from "./lucide"

const Fixture = createAnimatedIcon(["fixture"], function useArtwork() {
  return <path d="M2 2h20v20" />
})

beforeEach(() => {
  animation.controls.start.mockClear()
  animation.reduced = false
})

describe("animated icon integration", () => {
  it("keeps a real nested SVG, geometry, accessible name and SVG ref", () => {
    const ref = createRef<SVGSVGElement>()
    const view = render(<svg><Fixture ref={ref} x="88" y="86" width="32" height="26" strokeWidth="1.5" stroke="green" fill="none" role="img" aria-label="Local files" /></svg>)
    const icon = view.getByRole("img", { name: "Local files" })
    expect(ref.current).toBe(icon)
    expect(icon.namespaceURI).toBe("http://www.w3.org/2000/svg")
    expect(icon.parentElement?.tagName).toBe("svg")
    expect(["x", "y", "width", "height", "stroke-width", "stroke"].map((name) => icon.getAttribute(name))).toEqual(["88", "86", "32", "26", "1.5", "green"])
    expect(view.container.querySelector("div")).toBeNull()
    expect(icon.hasAttribute("aria-hidden")).toBe(false)
  })

  it("keeps current aliases bound to the same selected component", () => {
    expect(Check).toBe(CheckIcon)
    expect(Loader2).toBe(LoaderCircleIcon)
    expect(CircleHelp).toBe(HelpCircle)
  })

  it("uses button enter/leave without taking over click, focus or touch", () => {
    const click = vi.fn()
    const view = render(<Button onClick={click}><Fixture style={{ pointerEvents: "none" }} className="size-4 animate-spin" />Run</Button>)
    const button = view.getByRole("button", { name: "Run" })
    const icon = button.querySelector("svg")!
    fireEvent.focus(button)
    fireEvent.touchStart(button)
    fireEvent.click(button)
    expect(click).toHaveBeenCalledTimes(1)
    expect(animation.controls.start).not.toHaveBeenCalled()
    fireEvent.mouseEnter(button)
    fireEvent.mouseLeave(button)
    expect(animation.controls.start.mock.calls.map((args) => args[0])).toEqual(["animate", "normal"])
    expect(icon.style.pointerEvents).toBe("none")
    expect(icon.classList.contains("animate-spin")).toBe(true)
  })

  it("does not start animation on disabled or inert controls", () => {
    const view = render(<><Button disabled><Fixture />Disabled</Button><div inert><Button><Fixture />Inert</Button></div><div role="menuitem" data-disabled=""><Fixture />Unavailable</div></>)
    for (const owner of view.container.querySelectorAll("button,[role=menuitem]")) fireEvent.mouseEnter(owner)
    expect(animation.controls.start).not.toHaveBeenCalled()
  })

  it("leaves decorative input hit testing unchanged", () => {
    const view = render(<div data-testid="field"><Fixture style={{ pointerEvents: "none" }} /><input aria-label="Search" /></div>)
    fireEvent.mouseEnter(view.getByTestId("field"))
    expect(animation.controls.start).toHaveBeenCalledWith("animate")
    expect(view.container.querySelector("svg")?.style.pointerEvents).toBe("none")
    view.getByRole("textbox", { name: "Search" }).focus()
    expect(document.activeElement).toBe(view.getByRole("textbox", { name: "Search" }))
  })

  it("removes the listener when an icon leaves a retained control", () => {
    const view = render(<button><Fixture />Action</button>)
    const button = view.getByRole("button", { name: "Action" })
    fireEvent.mouseEnter(button)
    expect(animation.controls.start).toHaveBeenCalledTimes(1)
    view.rerender(<button>Action</button>)
    fireEvent.mouseLeave(button)
    fireEvent.mouseEnter(button)
    expect(animation.controls.start).toHaveBeenCalledTimes(1)
  })

  it("keeps the upstream animation opt-out and reduced-motion guard", () => {
    const view = render(<button><Fixture isAnimated={false} />Action</button>)
    fireEvent.mouseEnter(view.getByRole("button", { name: "Action" }))
    expect(animation.controls.start).not.toHaveBeenCalled()
    animation.reduced = true
    view.rerender(<button><Fixture />Action</button>)
    fireEvent.mouseEnter(view.getByRole("button", { name: "Action" }))
    expect(animation.controls.start).not.toHaveBeenCalled()
  })
})
