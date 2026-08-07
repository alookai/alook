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
    isError: false,
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
    (controller) => React.createElement("div", {
      "data-scroll-target": controller.scrollTargetId,
      onClick: () => controller.consumeScrollTarget("m_target"),
    }),
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

  it("keeps a loaded target until MessageList reports consumption", () => {
    mockedUseChannelMessageFeed.mockReturnValue(feed({
      messages: [{ id: "m_target" }],
    }))
    let renderer: TestRenderer.ReactTestRenderer

    act(() => {
      renderer = TestRenderer.create(renderSurface())
    })

    expect(renderer!.root.findByType("div").props["data-scroll-target"]).toBe("m_target")
    act(() => vi.advanceTimersByTime(5000))
    expect(renderer!.root.findByType("div").props["data-scroll-target"]).toBe("m_target")
    act(() => renderer!.root.findByType("div").props.onClick())
    expect(renderer!.root.findByType("div").props["data-scroll-target"]).toBeNull()
  })

  it("keeps a missing target across warm cache until the anchor request errors", () => {
    let surfaceFeed = feed({ messages: [{ id: "m_unrelated" }] })
    mockedUseChannelMessageFeed.mockImplementation(() => surfaceFeed)
    let renderer: TestRenderer.ReactTestRenderer

    act(() => {
      renderer = TestRenderer.create(renderSurface())
    })

    expect(renderer!.root.findByType("div").props["data-scroll-target"]).toBe("m_target")
    surfaceFeed = feed({ messages: [{ id: "m_unrelated" }], isError: true })
    act(() => renderer!.update(renderSurface()))
    expect(renderer!.root.findByType("div").props["data-scroll-target"]).toBeNull()
  })

  it("does not start a visual highlight timer for a loaded target", () => {
    mockedUseChannelMessageFeed.mockReturnValue(feed({
      messages: [{ id: "m_target" }],
    }))
    let renderer: TestRenderer.ReactTestRenderer

    act(() => {
      renderer = TestRenderer.create(renderSurface())
    })
    expect(vi.getTimerCount()).toBe(0)
    act(() => renderer!.unmount())
  })
})
