import { createElement } from "react"
import TestRenderer, { act } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
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
  const addEventListener = vi.fn()
  const removeEventListener = vi.fn()

  beforeEach(() => {
    pathname = "/c/me"
    addEventListener.mockReset()
    removeEventListener.mockReset()
    vi.stubGlobal("document", { addEventListener, removeEventListener })
    vi.stubGlobal("window", { getSelection: () => null })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
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
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(createElement(
        AuthenticatedContextMenuBoundary,
        null,
        createElement("span", null, "child"),
      ))
    })
    expect(addEventListener).toHaveBeenCalledOnce()
    expect(addEventListener).toHaveBeenCalledWith("contextmenu", expect.any(Function), { capture: true })

    await act(async () => renderer.unmount())
    expect(removeEventListener).toHaveBeenCalledOnce()
    expect(removeEventListener).toHaveBeenCalledWith(
      "contextmenu",
      addEventListener.mock.calls[0]?.[1],
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
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(tree())
    })
    expect(renderer.root.findByType("span").children).toEqual(["owned"])

    pathname = "/invite/token"
    await act(async () => renderer.update(tree()))
    expect(renderer.root.findByType("span").children).toEqual(["native"])
    expect(removeEventListener).toHaveBeenCalledOnce()

    pathname = "/w/demo/home"
    await act(async () => renderer.update(tree()))
    expect(renderer.root.findByType("span").children).toEqual(["owned"])
    expect(addEventListener).toHaveBeenCalledTimes(2)
    await act(async () => renderer.unmount())
  })

  it("never owns an initially excluded invite route", async () => {
    pathname = "/invite/token"
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(createElement(
        AuthenticatedContextMenuBoundary,
        null,
        createElement("span", null, "invite"),
      ))
    })
    expect(addEventListener).not.toHaveBeenCalled()
    await act(async () => renderer.unmount())
    expect(removeEventListener).not.toHaveBeenCalled()
  })
})
