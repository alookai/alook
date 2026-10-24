import { describe, expect, it } from "vitest"
import { fireEvent, render } from "@/test/react-dom-harness"
import { AnimatedAlookLogo, transformForProgress } from "./animated-alook-logo"

describe("character-only logo interaction", () => {
  it("keeps the default orange pose while focused and restores normal interaction when disabled", () => {
    const view = render(<button><AnimatedAlookLogo /></button>)
    const button = view.getByRole("button")
    const orange = view.container.querySelector('[data-face="orange"]')!
    fireEvent.focus(button)
    expect(orange).toHaveAttribute("transform", transformForProgress(1))

    view.rerender(<button><AnimatedAlookLogo characterOnly /></button>)
    fireEvent.pointerEnter(button)
    fireEvent.focus(button)
    expect(orange).toHaveAttribute("transform", transformForProgress(0))
    expect(view.container.querySelectorAll('[data-face][opacity="0"]')).toHaveLength(4)

    view.rerender(<button><AnimatedAlookLogo /></button>)
    fireEvent.pointerEnter(button)
    expect(orange).toHaveAttribute("transform", transformForProgress(1))
    expect(view.container.querySelectorAll('[data-face][opacity="0"]')).toHaveLength(0)
    fireEvent.pointerLeave(button)
    fireEvent.blur(button)
    expect(orange).toHaveAttribute("transform", transformForProgress(0))
  })
})
