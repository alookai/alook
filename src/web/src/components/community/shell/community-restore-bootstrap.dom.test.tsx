import React from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen } from "@/test/react-dom-harness"
import { CommunityRestoreBoundary } from "./community-restore-bootstrap"

const restoring = vi.hoisted(() => ({ current: false }))
const queryClient = vi.hoisted(() => ({
  getQueryData: vi.fn<() => unknown>(() => undefined),
}))

vi.mock("@tanstack/react-query", () => ({
  useIsRestoring: () => restoring.current,
  useQueryClient: () => queryClient,
}))

beforeEach(() => {
  restoring.current = false
  queryClient.getQueryData.mockReset()
  queryClient.getQueryData.mockReturnValue(undefined)
})

describe("CommunityRestoreBoundary", () => {
  it("keeps region-owned skeletons mounted while IndexedDB restore is unresolved", () => {
    restoring.current = true
    const renderer = render(React.createElement(
      CommunityRestoreBoundary,
      null,
      React.createElement(
        "div",
        { "data-testid": "content" },
        React.createElement("div", {
          "data-slot": "skeleton",
          className: "animate-pulse rounded-md bg-muted",
        }),
      ),
    ))

    const content = screen.getByTestId("content")
    expect(renderer.container.querySelector('[data-slot="community-restore-bootstrap"]')).toBeNull()
    expect(renderer.container.querySelector('[data-slot="skeleton"]')).toHaveClass(
      "animate-pulse",
      "bg-muted",
    )

    restoring.current = false
    renderer.rerender(React.createElement(
      CommunityRestoreBoundary,
      null,
      React.createElement(
        "div",
        { "data-testid": "content" },
        React.createElement("div", { "data-slot": "skeleton" }),
      ),
    ))
    expect(screen.getByTestId("content")).toBe(content)
  })

  it("marks restore, cached paint, and stable geometry in lifecycle order", () => {
    const marks: string[] = []
    vi.spyOn(performance, "mark").mockImplementation((name) => {
      marks.push(name)
      return {} as PerformanceMark
    })
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0)
      return 1
    })
    queryClient.getQueryData.mockReturnValue({ cached: true })
    restoring.current = true
    const renderer = render(React.createElement(
      CommunityRestoreBoundary,
      null,
      React.createElement("div", { "data-testid": "content" }),
    ))

    restoring.current = false
    renderer.rerender(React.createElement(
      CommunityRestoreBoundary,
      null,
      React.createElement("div", { "data-testid": "content" }),
    ))

    expect(marks).toEqual([
      "alook:restore:start",
      "alook:restore:complete",
      "alook:restore:first-cached-paint",
      "alook:restore:stable",
    ])
  })
})
