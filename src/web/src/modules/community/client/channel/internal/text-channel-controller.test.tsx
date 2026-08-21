import { createRequire } from "node:module"
import React from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  breakpoint: "desktop" as "desktop" | "mobile",
  feed: { messages: [], isLoading: false } as Record<string, any>,
  viewProps: null as Record<string, any> | null,
  controllerProps: null as Record<string, any> | null,
}))

vi.mock("@/hooks/use-mobile", () => ({ useBreakpoint: () => mocks.breakpoint }))
vi.mock("@/hooks/community/use-channel-message-feed", () => ({
  useChannelMessageFeed: (props: Record<string, unknown>) => {
    mocks.feed.input = props
    return mocks.feed
  },
}))
vi.mock("../../messaging", () => ({
  Composer: () => null,
  MessageChannelController: (props: Record<string, any>) => {
    mocks.controllerProps = props
    return props.children({ feed: props.feed, pinnedIds: new Set() })
  },
}))
vi.mock("./text-channel-view", () => ({
  TextChannelView: (props: Record<string, any>) => {
    mocks.viewProps = props
    return React.createElement("text-channel-view")
  },
}))

import { TextChannelController, type TextChannelControllerProps } from "./text-channel-controller"

type Renderer = { unmount: () => void; update: (element: React.ReactElement) => void }
const rendererModule = createRequire(import.meta.url)("react-test-renderer") as {
  act: (callback: () => void) => void
  create: (element: React.ReactElement) => Renderer
}
const { act } = rendererModule

function props(channelId = "channel_1"): TextChannelControllerProps {
  return {
    channelId,
    serverId: "server_1",
    serverParam: "server_1",
    channelName: "general",
    viewer: { id: "viewer_1", name: "Viewer", avatar: "V" },
    anchorMessageId: "message_1",
    notificationLevel: "Use Server Default",
    onSetNotificationLevel: vi.fn(),
    composerMembers: [],
    onSearchComposerMembers: vi.fn(),
    channelRefCandidates: [],
    memberPanelProps: { members: [], onSearchMembers: vi.fn() } as never,
    manageMembersDialog: null,
    uiHandlers: {},
    onOpenThread: vi.fn(),
    onOpenProfile: vi.fn(),
    resolveUserName: (id) => id,
  }
}

describe("TextChannelController", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.breakpoint = "desktop"
    mocks.feed = { messages: [], isLoading: false }
    mocks.viewProps = null
    mocks.controllerProps = null
  })

  it("owns the feed, breakpoint, and right-panel lifecycle", () => {
    let renderer: Renderer
    act(() => { renderer = rendererModule.create(<TextChannelController {...props()} />) })
    expect(mocks.feed.input).toEqual({
      channelId: "channel_1",
      serverId: "server_1",
      viewerUserId: "viewer_1",
      isChildChannel: false,
      anchorMessageId: "message_1",
    })
    expect(mocks.viewProps).toMatchObject({ autoFocus: true, rightPanel: null })

    act(() => mocks.viewProps!.onTogglePanel("members"))
    expect(mocks.viewProps!.rightPanel).toBe("members")
    act(() => mocks.viewProps!.onTogglePanel("members"))
    expect(mocks.viewProps!.rightPanel).toBeNull()
    act(() => mocks.controllerProps!.onOpenPinned())
    expect(mocks.viewProps!.rightPanel).toBe("pinned")
    act(() => mocks.viewProps!.onClosePanel())
    expect(mocks.viewProps!.rightPanel).toBeNull()

    act(() => mocks.viewProps!.onTogglePanel("threads"))
    act(() => renderer!.update(<TextChannelController {...props("channel_2")} />))
    expect(mocks.viewProps!.rightPanel).toBeNull()
    act(() => renderer!.unmount())
  })

  it("disables autofocus on mobile", () => {
    mocks.breakpoint = "mobile"
    act(() => { rendererModule.create(<TextChannelController {...props()} />) })
    expect(mocks.viewProps!.autoFocus).toBe(false)
  })
})
