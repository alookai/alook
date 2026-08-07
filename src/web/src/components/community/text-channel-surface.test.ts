import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { TextChannelSurface } from "./text-channel-surface"
import { useChannelMessageFeed } from "@/hooks/community/use-channel-message-feed"

vi.mock("@/hooks/community/use-channel-message-feed", () => ({
  useChannelMessageFeed: vi.fn(),
}))

const mockedUseChannelMessageFeed = vi.mocked(useChannelMessageFeed)

function feed(overrides: Record<string, unknown> = {}) {
  return {
    messages: [],
    isLoading: false,
    isFetchingOlder: false,
    isFetchingNewer: false,
    pinned: [],
    ...overrides,
  } as ReturnType<typeof useChannelMessageFeed>
}

function renderSurface(targetId = "m_target") {
  return React.createElement(
    TextChannelSurface,
    {
      channelId: "channel_1",
      serverId: "server_1",
      viewerUserId: "viewer_1",
      anchorMessageId: targetId,
    },
    (controller) => React.createElement("div", { "data-scroll-target": controller.scrollTargetId }),
  )
}

describe("TextChannelSurface scroll target ownership", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it("passes the route anchor through the loading surface to its message-list slot", () => {
    mockedUseChannelMessageFeed.mockReturnValue(feed({ isLoading: true }))
    let renderer: TestRenderer.ReactTestRenderer

    act(() => {
      renderer = TestRenderer.create(renderSurface())
    })

    expect(renderer!.root.findByType("div").props["data-scroll-target"]).toBe("m_target")
  })

  it("keeps the target through anchor arrival and clears it after 1600ms", () => {
    mockedUseChannelMessageFeed.mockReturnValue(feed({
      messages: [{ id: "m_target" }],
    }))
    let renderer: TestRenderer.ReactTestRenderer

    act(() => {
      renderer = TestRenderer.create(renderSurface())
    })

    expect(renderer!.root.findByType("div").props["data-scroll-target"]).toBe("m_target")
    act(() => vi.advanceTimersByTime(1599))
    expect(renderer!.root.findByType("div").props["data-scroll-target"]).toBe("m_target")
    act(() => vi.advanceTimersByTime(1))
    expect(renderer!.root.findByType("div").props["data-scroll-target"]).toBeNull()
  })

  it("clears once the authoritative surface feed settles without the target", () => {
    mockedUseChannelMessageFeed.mockReturnValue(feed())
    let renderer: TestRenderer.ReactTestRenderer

    act(() => {
      renderer = TestRenderer.create(renderSurface())
    })

    expect(renderer!.root.findByType("div").props["data-scroll-target"]).toBeNull()
  })

  it("cancels a pending clear when the surface unmounts", () => {
    mockedUseChannelMessageFeed.mockReturnValue(feed({
      messages: [{ id: "m_target" }],
    }))
    let renderer: TestRenderer.ReactTestRenderer

    act(() => {
      renderer = TestRenderer.create(renderSurface())
    })
    act(() => {
      renderer!.unmount()
    })

    expect(vi.getTimerCount()).toBe(0)
  })
})
