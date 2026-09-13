import React from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, render } from "@/test/react-dom-harness"
import {
  INITIAL_POSITION_CROSSFADE_MS,
  INITIAL_POSITION_EFFECT_DELAY_MS,
  INITIAL_POSITION_MINIMUM_EFFECT_MS,
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
      auroraVisible: false,
    })
    expect(vi.getTimerCount()).toBe(0)
  })

  it("skips aurora when position settles before the 800ms threshold", () => {
    expect(INITIAL_POSITION_EFFECT_DELAY_MS).toBe(800)
    const renderer = render(React.createElement(Probe, pending()))
    expect(latest.phase).toBe("positioning")

    act(() => vi.advanceTimersByTime(80))
    expect(latest.phase).toBe("positioning")
    act(() => vi.advanceTimersByTime(719))
    expect(latest.phase).toBe("positioning")
    renderer.rerender(React.createElement(Probe, { ...pending(), positionSettled: true }))
    expect(latest).toMatchObject({
      phase: "revealed",
      contentVisible: true,
      contentInteractive: true,
      auroraVisible: false,
    })

    act(() => vi.runAllTimers())
    expect(latest.phase).toBe("revealed")
  })

  it("holds a shown aurora through its entrance and crossfades for 300ms", () => {
    expect(INITIAL_POSITION_MINIMUM_EFFECT_MS).toBeGreaterThanOrEqual(INITIAL_POSITION_CROSSFADE_MS)
    const renderer = render(React.createElement(Probe, pending()))
    act(() => vi.advanceTimersByTime(799))
    expect(latest.phase).toBe("positioning")
    act(() => vi.advanceTimersByTime(1))
    expect(latest).toMatchObject({ phase: "aurora", contentVisible: false, auroraVisible: true })

    renderer.rerender(React.createElement(Probe, { ...pending(), positionSettled: true }))
    act(() => vi.advanceTimersByTime(INITIAL_POSITION_MINIMUM_EFFECT_MS - 1))
    expect(latest.phase).toBe("aurora")
    act(() => vi.advanceTimersByTime(1))
    expect(latest).toMatchObject({ phase: "revealing", contentVisible: true, auroraVisible: true })

    act(() => vi.advanceTimersByTime(INITIAL_POSITION_CROSSFADE_MS - 1))
    expect(latest.phase).toBe("revealing")
    act(() => vi.advanceTimersByTime(1))
    expect(latest).toMatchObject({ phase: "revealed", auroraVisible: false })
  })

  it("times out to best-known content and ignores every late readiness change", () => {
    const renderer = render(React.createElement(Probe, pending()))
    act(() => vi.advanceTimersByTime(INITIAL_POSITION_TIMEOUT_MS))
    expect(latest).toMatchObject({ phase: "revealing", contentVisible: true })

    renderer.rerender(React.createElement(Probe, { ...pending(), positionSettled: true }))
    renderer.rerender(React.createElement(Probe, {
      firstWindowReady: false,
      authoritativeEmpty: false,
      positionSettled: false,
    }))
    expect(latest.phase).toBe("revealing")

    act(() => vi.advanceTimersByTime(INITIAL_POSITION_CROSSFADE_MS))
    expect(latest).toMatchObject({ phase: "revealed", showSkeleton: false })

    renderer.rerender(React.createElement(Probe, pending()))
    act(() => vi.runAllTimers())
    expect(latest).toMatchObject({ phase: "revealed", auroraVisible: false })
  })

  it("cleans delayed effect and timeout timers when a keyed mount leaves", () => {
    const renderer = render(React.createElement(Probe, pending()))
    expect(vi.getTimerCount()).toBe(2)
    renderer.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})
