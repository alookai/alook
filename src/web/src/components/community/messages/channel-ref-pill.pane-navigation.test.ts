import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ChannelRefPill } from "./channel-ref-pill"
import { ChannelPill } from "./inline-marks"
import { MessagePaneNavigationProvider } from "./message-pane-navigation"

const mocks = vi.hoisted(() => ({
  routeChannelId: "child",
  globalJump: vi.fn(),
  globalContext: vi.fn(),
}))

vi.mock("@/stores/community", () => ({
  useCommunityStore: (selector: (state: {
    currentServerId: string
    currentChannelId: string
  }) => unknown) => selector({
    currentServerId: "server",
    currentChannelId: mocks.routeChannelId,
  }),
  useUiHandlers: () => ({
    jumpToSeq: mocks.globalJump,
    openMessageContext: mocks.globalContext,
    navigate: vi.fn(),
  }),
}))

vi.mock("@/hooks/community/use-channel-ref-directory", () => ({
  useChannelRefDirectory: () => ({ directory: {} }),
}))

vi.mock("@/hooks/community/use-channel-panels", () => ({
  useThreads: () => ({ threads: [], isLoading: false }),
}))

vi.mock("@/lib/community/channel-ref", () => ({
  resolveChannelRefBase: () => ({
    server: { id: "server", name: "Server" },
    channel: { id: "parent", name: "parent" },
    seq: 7,
  }),
}))

function renderRef(
  channelId: string,
  jumpToSeq: (seq: number) => void,
  openMessageContext: (target: {
    serverId: string
    channelId: string
    label: string
    seq: number
  }) => void,
) {
  return React.createElement(
    MessagePaneNavigationProvider,
    { channelId, jumpToSeq, openMessageContext },
    React.createElement(ChannelRefPill, null, "/server/parent#7"),
  )
}

describe("ChannelRefPill pane navigation ownership", () => {
  beforeEach(() => vi.clearAllMocks())

  it("routes a parent-pane message ref to the parent controller while the route owns the child", () => {
    const parentJump = vi.fn()
    const parentContext = vi.fn()
    let renderer: TestRenderer.ReactTestRenderer

    act(() => {
      renderer = TestRenderer.create(renderRef("parent", parentJump, parentContext))
    })

    act(() => renderer!.root.findByType(ChannelPill).props.onClick())

    expect(parentJump).toHaveBeenCalledWith(7)
    expect(parentContext).not.toHaveBeenCalled()
    expect(mocks.globalJump).not.toHaveBeenCalled()
    expect(mocks.globalContext).not.toHaveBeenCalled()
  })

  it("opens cross-channel context in the child pane that contains the ref", () => {
    const childJump = vi.fn()
    const childContext = vi.fn()
    let renderer: TestRenderer.ReactTestRenderer

    act(() => {
      renderer = TestRenderer.create(renderRef("child", childJump, childContext))
    })

    act(() => renderer!.root.findByType(ChannelPill).props.onClick())

    expect(childJump).not.toHaveBeenCalled()
    expect(childContext).toHaveBeenCalledWith({
      serverId: "server",
      channelId: "parent",
      label: "parent",
      seq: 7,
    })
    expect(mocks.globalJump).not.toHaveBeenCalled()
    expect(mocks.globalContext).not.toHaveBeenCalled()
  })
})
