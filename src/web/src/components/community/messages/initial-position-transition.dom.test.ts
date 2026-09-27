import React from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, render } from "@/test/react-dom-harness"
import {
  INITIAL_POSITION_CROSSFADE_MS,
  INITIAL_POSITION_TIMEOUT_MS,
  useInitialPositionTransition,
} from "./initial-position-transition"

type Input = {
  firstWindowReady: boolean
  authoritativeEmpty: boolean
  positionSettled: boolean
}

let latest: ReturnType<typeof useInitialPositionTransition>

function Probe(input: Input) {
  const transition = useInitialPositionTransition(input)
  React.useLayoutEffect(() => { latest = transition }, [transition])
  return React.createElement("div", { "data-phase": transition.phase })
}

const pending = (): Input => ({
  firstWindowReady: true,
  authoritativeEmpty: false,
  positionSettled: false,
})

describe("useInitialPositionTransition", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(0))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("holds the skeleton until the first window and reveals an authoritative empty window immediately", () => {
    const renderer = render(React.createElement(Probe, {
      firstWindowReady: false,
      authoritativeEmpty: false,
      positionSettled: false,
    }))
    expect(latest).toMatchObject({ phase: "skeleton", showSkeleton: true })

    renderer.rerender(React.createElement(Probe, {
      firstWindowReady: true,
      authoritativeEmpty: true,
      positionSettled: false,
    }))
    expect(latest).toMatchObject({
      phase: "revealed",
      showSkeleton: false,
      contentVisible: true,
    })
    expect(vi.getTimerCount()).toBe(0)
  })

  it("crossfades as soon as position settles", () => {
    const renderer = render(React.createElement(Probe, pending()))
    expect(latest.phase).toBe("positioning")

    act(() => vi.advanceTimersByTime(799))
    expect(latest.phase).toBe("positioning")
    renderer.rerender(React.createElement(Probe, { ...pending(), positionSettled: true }))
    expect(latest).toMatchObject({
      phase: "revealing",
      contentVisible: true,
      contentInteractive: true,
    })

    act(() => vi.advanceTimersByTime(INITIAL_POSITION_CROSSFADE_MS))
    expect(latest.phase).toBe("revealed")
  })

  it("does not let the timeout expose content before position settlement", () => {
    const renderer = render(React.createElement(Probe, pending()))
    act(() => vi.advanceTimersByTime(INITIAL_POSITION_TIMEOUT_MS))
    expect(latest).toMatchObject({
      phase: "positioning",
      contentVisible: false,
      contentInteractive: false,
    })

    renderer.rerender(React.createElement(Probe, { ...pending(), positionSettled: true }))
    act(() => vi.advanceTimersByTime(0))
    expect(latest).toMatchObject({
      phase: "revealing",
      contentVisible: true,
      contentInteractive: true,
    })

    act(() => vi.advanceTimersByTime(INITIAL_POSITION_CROSSFADE_MS))
    expect(latest).toMatchObject({ phase: "revealed", showSkeleton: false })
  })

  it("preserves the crossfade when settlement arrives after the timeout window", () => {
    const renderer = render(React.createElement(Probe, pending()))
    act(() => vi.advanceTimersByTime(
      INITIAL_POSITION_TIMEOUT_MS + INITIAL_POSITION_CROSSFADE_MS,
    ))
    expect(latest).toMatchObject({
      phase: "positioning",
      contentVisible: false,
      contentInteractive: false,
    })

    renderer.rerender(React.createElement(Probe, { ...pending(), positionSettled: true }))
    act(() => vi.advanceTimersByTime(0))
    expect(latest).toMatchObject({
      phase: "revealing",
      contentVisible: true,
      contentInteractive: true,
    })

    act(() => vi.advanceTimersByTime(INITIAL_POSITION_CROSSFADE_MS - 1))
    expect(latest.phase).toBe("revealing")
    act(() => vi.advanceTimersByTime(1))
    expect(latest).toMatchObject({ phase: "revealed" })
  })

  it("cleans the timeout timer when a keyed mount leaves", () => {
    const renderer = render(React.createElement(Probe, pending()))
    expect(vi.getTimerCount()).toBe(1)
    renderer.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})
