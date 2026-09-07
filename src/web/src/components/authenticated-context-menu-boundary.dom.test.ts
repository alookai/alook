import { createElement } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen } from "@/test/react-dom-harness"
import {
  AuthenticatedContextMenuBoundary,
  createAuthenticatedContextMenuHandler,
  useAuthenticatedContextMenuPolicy,
} from "./authenticated-context-menu-boundary"

let pathname = "/c/me"

vi.mock("next/navigation", () => ({
  usePathname: () => pathname,
}))

describe("AuthenticatedContextMenuBoundary", () => {
  let addEventListener: ReturnType<typeof vi.spyOn>
  let removeEventListener: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    pathname = "/c/me"
    addEventListener = vi.spyOn(document, "addEventListener")
    removeEventListener = vi.spyOn(document, "removeEventListener")
    vi.spyOn(window, "getSelection").mockReturnValue(null)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("prevents only product disposition without stopping propagation", () => {
    const preventDefault = vi.fn()
    const stopPropagation = vi.fn()
    const stopImmediatePropagation = vi.fn()
    const event = { preventDefault, stopPropagation, stopImmediatePropagation } as unknown as MouseEvent

    createAuthenticatedContextMenuHandler(() => "product")(event)
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(stopPropagation).not.toHaveBeenCalled()
    expect(stopImmediatePropagation).not.toHaveBeenCalled()

    preventDefault.mockClear()
    createAuthenticatedContextMenuHandler(() => "native")(event)
    expect(preventDefault).not.toHaveBeenCalled()
    expect(stopPropagation).not.toHaveBeenCalled()
    expect(stopImmediatePropagation).not.toHaveBeenCalled()
  })

  it("owns exactly one capture listener and removes it on unmount", async () => {
    const renderer = render(createElement(
      AuthenticatedContextMenuBoundary,
      null,
      createElement("span", null, "child"),
    ))
    const contextCalls = addEventListener.mock.calls.filter(([type]) => type === "contextmenu")
    expect(contextCalls).toHaveLength(1)
    expect(addEventListener).toHaveBeenCalledWith("contextmenu", expect.any(Function), { capture: true })

    renderer.unmount()
    const removalCalls = removeEventListener.mock.calls.filter(([type]) => type === "contextmenu")
    expect(removalCalls).toHaveLength(1)
    expect(removeEventListener).toHaveBeenCalledWith(
      "contextmenu",
      contextCalls[0]?.[1],
      { capture: true },
    )
  })

  it("removes ownership on workspace invite navigation and restores it once", async () => {
    function Status() {
      return createElement("span", null, useAuthenticatedContextMenuPolicy() ? "owned" : "native")
    }
    const tree = () => createElement(
      AuthenticatedContextMenuBoundary,
      null,
      createElement(Status),
    )
    const renderer = render(tree())
    expect(screen.getByText("owned")).toBeInTheDocument()

    pathname = "/invite/token"
    renderer.rerender(tree())
    expect(screen.getByText("native")).toBeInTheDocument()
    expect(removeEventListener.mock.calls.filter(([type]) => type === "contextmenu")).toHaveLength(1)

    pathname = "/w/demo/home"
    renderer.rerender(tree())
    expect(screen.getByText("owned")).toBeInTheDocument()
    expect(addEventListener.mock.calls.filter(([type]) => type === "contextmenu")).toHaveLength(2)
    renderer.unmount()
  })

  it("never owns an initially excluded invite route", async () => {
    pathname = "/invite/token"
    const renderer = render(createElement(
      AuthenticatedContextMenuBoundary,
      null,
      createElement("span", null, "invite"),
    ))
    expect(addEventListener.mock.calls.filter(([type]) => type === "contextmenu")).toHaveLength(0)
    renderer.unmount()
    expect(removeEventListener.mock.calls.filter(([type]) => type === "contextmenu")).toHaveLength(0)
  })
})
