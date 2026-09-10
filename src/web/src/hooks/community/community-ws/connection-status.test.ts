import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  COMMUNITY_WS_FAILED_AFTER_MS,
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

  it("keeps slow and repeatedly failing initial connection attempts non-blocking", () => {
    const { controller, publish } = setup()
    controller.handlePhase("reconnecting")
    expect(publish).toHaveBeenLastCalledWith("connected")

    vi.advanceTimersByTime(COMMUNITY_WS_FAILED_AFTER_MS * 2)
    expect(publish).not.toHaveBeenCalledWith("reconnecting")
    expect(publish).not.toHaveBeenCalledWith("failed")

    controller.handlePhase("suspended")
    controller.handlePhase("reconnecting")
    vi.advanceTimersByTime(COMMUNITY_WS_FAILED_AFTER_MS * 2)
    expect(publish.mock.calls.every(([status]) => status === "connected")).toBe(true)
    expect(publish).not.toHaveBeenCalledWith("failed")
  })

  it("records the first authentication without treating its handshake as an outage", () => {
    const { controller, publish } = setup()
    controller.handlePhase("reconnecting")
    controller.handlePhase("authenticated")
    vi.advanceTimersByTime(COMMUNITY_WS_FAILED_AFTER_MS)
    expect(publish).toHaveBeenLastCalledWith("connected")
    expect(publish).not.toHaveBeenCalledWith("reconnecting")
    expect(publish).not.toHaveBeenCalledWith("failed")
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

  it("keeps hidden validation quiet and starts the outage clock only on failure", () => {
    const { controller, publish } = setup()
    controller.handlePhase("reconnecting")
    controller.handlePhase("authenticated")
    controller.handlePhase("suspended")
    publish.mockClear()

    vi.advanceTimersByTime(COMMUNITY_WS_FAILED_AFTER_MS + 1)
    expect(publish).not.toHaveBeenCalled()

    controller.handlePhase("authenticated")
    expect(publish).toHaveBeenLastCalledWith("connected")
    publish.mockClear()

    controller.handlePhase("reconnecting")
    expect(publish).toHaveBeenCalledOnce()
    expect(publish).toHaveBeenLastCalledWith("reconnecting")
    vi.advanceTimersByTime(COMMUNITY_WS_FAILED_AFTER_MS - 1)
    expect(publish).not.toHaveBeenCalledWith("failed")
    vi.advanceTimersByTime(1)
    expect(publish).toHaveBeenLastCalledWith("failed")

    controller.handlePhase("authenticated")
    expect(publish).toHaveBeenLastCalledWith("connected")
  })

  it("suspends hidden outages and starts fresh thresholds when visible again", () => {
    const { controller, publish } = setup()
    controller.handlePhase("reconnecting")
    controller.handlePhase("authenticated")
    publish.mockClear()

    controller.handlePhase("reconnecting")
    vi.advanceTimersByTime(COMMUNITY_WS_FAILED_AFTER_MS - 1)
    controller.handlePhase("suspended")
    vi.advanceTimersByTime(COMMUNITY_WS_FAILED_AFTER_MS)
    expect(publish).toHaveBeenLastCalledWith("connected")
    expect(publish).not.toHaveBeenCalledWith("failed")

    controller.handlePhase("reconnecting")
    expect(publish).toHaveBeenLastCalledWith("reconnecting")
    vi.advanceTimersByTime(COMMUNITY_WS_FAILED_AFTER_MS)
    expect(publish).toHaveBeenLastCalledWith("failed")
  })

  it("manual retry leaves failed immediately, calls one transport retry, and rearms failure", () => {
    const { controller, publish, reconnectTransport } = setup()
    controller.handlePhase("reconnecting")
    controller.handlePhase("authenticated")
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

  it("keeps a pre-auth manual transport retry non-blocking", () => {
    const { controller, publish, reconnectTransport } = setup()
    controller.handlePhase("reconnecting")

    controller.reconnectNow()
    vi.advanceTimersByTime(COMMUNITY_WS_FAILED_AFTER_MS)

    expect(publish.mock.calls.every(([status]) => status === "connected")).toBe(true)
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
