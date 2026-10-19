import React from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render } from "@/test/react-dom-harness"
import { useInitialPositionTransition } from "./initial-position-transition"

type Input = Parameters<typeof useInitialPositionTransition>[0]
let latest: ReturnType<typeof useInitialPositionTransition>
function Probe(input: Input) {
  const presentation = useInitialPositionTransition(input)
  React.useLayoutEffect(() => { latest = presentation }, [presentation])
  return React.createElement("div", { "data-phase": presentation.phase })
}
const pending: Input = { firstWindowReady: true, authoritativeEmpty: false, positionSettled: false }

describe("immediate initial message presentation", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())
  it("shows a qualified first window and accepts user takeover before position settles", () => {
    render(React.createElement(Probe, pending))
    expect(latest).toEqual({ phase: "positioning", showSkeleton: false, contentVisible: true, contentInteractive: true })
    expect(vi.getTimerCount()).toBe(0)
  })
  it("holds the skeleton until the first window is qualified and reveals an empty window immediately", () => {
    const view = render(React.createElement(Probe, { ...pending, firstWindowReady: false }))
    expect(latest).toEqual({ phase: "skeleton", showSkeleton: true, contentVisible: false, contentInteractive: false })
    view.rerender(React.createElement(Probe, { ...pending, authoritativeEmpty: true }))
    expect(latest).toMatchObject({ phase: "revealed", showSkeleton: false, contentVisible: true })
    expect(vi.getTimerCount()).toBe(0)
  })
  it("records actual position settlement without a timed revealing phase", () => {
    const view = render(React.createElement(Probe, pending))
    view.rerender(React.createElement(Probe, { ...pending, positionSettled: true }))
    expect(latest).toMatchObject({ phase: "revealed", contentVisible: true, contentInteractive: true })
    expect(vi.getTimerCount()).toBe(0)
    view.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
  it("hides content again if its first-window qualification is lost", () => {
    const view = render(React.createElement(Probe, { ...pending, positionSettled: true }))
    view.rerender(React.createElement(Probe, { ...pending, firstWindowReady: false }))
    expect(latest).toMatchObject({ showSkeleton: true, contentVisible: false, contentInteractive: false })
  })
})
