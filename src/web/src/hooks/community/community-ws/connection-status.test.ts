import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  COMMUNITY_WS_FAILED_AFTER_MS,
  COMMUNITY_WS_RECONNECTING_GRACE_MS,
  createCommunityWsConnectionStatusController,
} from "./connection-status"

describe("community websocket connection status", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  function setup() {
    const publish = vi.fn()
    const reconnectTransport = vi.fn()
    const controller = createCommunityWsConnectionStatusController({
      publish,
      reconnectTransport,
    })
    return { controller, publish, reconnectTransport }
  }

  it("hides a short initial handshake and clears both thresholds on auth", () => {
    const { controller, publish } = setup()
    controller.handlePhase("reconnecting")
    expect(publish).toHaveBeenLastCalledWith("connected")

    vi.advanceTimersByTime(COMMUNITY_WS_RECONNECTING_GRACE_MS - 1)
    expect(publish).not.toHaveBeenCalledWith("reconnecting")

    controller.handlePhase("authenticated")
    vi.advanceTimersByTime(COMMUNITY_WS_FAILED_AFTER_MS)
    expect(publish).toHaveBeenLastCalledWith("connected")
    expect(publish).not.toHaveBeenCalledWith("failed")
  })

  it("publishes reconnecting after grace and failed after one continuous outage", () => {
    const { controller, publish } = setup()
    controller.handlePhase("reconnecting")
    vi.advanceTimersByTime(COMMUNITY_WS_RECONNECTING_GRACE_MS)
    expect(publish).toHaveBeenLastCalledWith("reconnecting")

    controller.handlePhase("reconnecting")
    vi.advanceTimersByTime(COMMUNITY_WS_FAILED_AFTER_MS - COMMUNITY_WS_RECONNECTING_GRACE_MS)
    expect(publish).toHaveBeenLastCalledWith("failed")
    expect(publish.mock.calls.filter(([status]) => status === "failed")).toHaveLength(1)
  })

  it("publishes reconnecting immediately after a previously authenticated socket drops", () => {
    const { controller, publish } = setup()
    controller.handlePhase("reconnecting")
    controller.handlePhase("authenticated")
    publish.mockClear()

    controller.handlePhase("reconnecting")
    expect(publish).toHaveBeenCalledOnce()
    expect(publish).toHaveBeenLastCalledWith("reconnecting")

    vi.advanceTimersByTime(COMMUNITY_WS_FAILED_AFTER_MS)
    expect(publish).toHaveBeenLastCalledWith("failed")
  })

  it("suspends hidden outages and starts fresh thresholds when visible again", () => {
    const { controller, publish } = setup()
    controller.handlePhase("reconnecting")
    vi.advanceTimersByTime(COMMUNITY_WS_RECONNECTING_GRACE_MS)
    controller.handlePhase("suspended")
    vi.advanceTimersByTime(COMMUNITY_WS_FAILED_AFTER_MS)
    expect(publish).toHaveBeenLastCalledWith("connected")

    controller.handlePhase("reconnecting")
    vi.advanceTimersByTime(COMMUNITY_WS_RECONNECTING_GRACE_MS)
    expect(publish).toHaveBeenLastCalledWith("reconnecting")
  })

  it("manual retry leaves failed immediately, calls one transport retry, and rearms failure", () => {
    const { controller, publish, reconnectTransport } = setup()
    controller.handlePhase("reconnecting")
    vi.advanceTimersByTime(COMMUNITY_WS_FAILED_AFTER_MS)
    expect(publish).toHaveBeenLastCalledWith("failed")

    controller.reconnectNow()
    expect(publish).toHaveBeenLastCalledWith("reconnecting")
    expect(reconnectTransport).toHaveBeenCalledOnce()

    controller.handlePhase("reconnecting")
    vi.advanceTimersByTime(COMMUNITY_WS_FAILED_AFTER_MS)
    expect(publish).toHaveBeenLastCalledWith("failed")
    expect(reconnectTransport).toHaveBeenCalledOnce()
  })

  it("dispose clears timers and ignores callbacks or retries", () => {
    const { controller, publish, reconnectTransport } = setup()
    controller.handlePhase("reconnecting")
    controller.dispose()
    vi.runAllTimers()
    controller.handlePhase("reconnecting")
    controller.reconnectNow()
    expect(publish).toHaveBeenCalledTimes(1)
    expect(reconnectTransport).not.toHaveBeenCalled()
  })
})
