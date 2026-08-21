import { createRequire } from "node:module"
import React from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  breakpoint: "desktop" as "desktop" | "mobile",
  search: "msg=message_1&keep=1",
  channelNotif: { channel_1: "Nothing" } as Record<string, string>,
  currentChannelId: "channel_1",
  route: {} as Record<string, any>,
  opener: { data: null as null | { content: string }, isLoading: false },
  viewProps: null as Record<string, any> | null,
  replace: vi.fn(),
  replacePath: vi.fn(),
  goBackMobile: vi.fn(),
  navigatePath: vi.fn(),
  openProfile: vi.fn(),
  setLastChannel: vi.fn(),
  setChannelNotif: vi.fn(),
}))

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mocks.replace }),
  useSearchParams: () => new URLSearchParams(mocks.search),
}))
vi.mock("@/hooks/use-mobile", () => ({ useBreakpoint: () => mocks.breakpoint }))
vi.mock("@/contexts/community/current-user", () => ({
  useCurrentUser: () => ({ id: "viewer_1", name: "Viewer", avatar: "V" }),
}))
vi.mock("@/stores/community", () => ({
  useCurrentChannelId: () => mocks.currentChannelId,
  useUiHandlers: () => ({
    replacePath: mocks.replacePath,
    goBackMobile: mocks.goBackMobile,
    openProfile: mocks.openProfile,
  }),
  useCommunityStore: { getState: () => ({ uiHandlers: { navigatePath: mocks.navigatePath } }) },
}))
vi.mock("@/lib/community/last-channel", () => ({ setLastChannel: mocks.setLastChannel }))
vi.mock("@/hooks/community/use-forum-opener-hint", () => ({ useForumOpenerHint: () => mocks.opener }))
vi.mock("@/hooks/community/use-notification-settings", () => ({
  useNotificationSettings: () => ({ channel: mocks.channelNotif }),
}))
vi.mock("@/hooks/community/mutations", () => ({
  useSetChannelNotif: () => ({ mutate: mocks.setChannelNotif }),
}))
vi.mock("@/components/community/members/channel-member-view-model", () => ({
  useChannelMemberViewModel: () => ({
    composerMembers: [],
    onSearchComposerMembers: vi.fn(),
    memberPanelProps: { members: [] },
    manageMembersDialog: null,
    resolveUserName: (id: string) => id,
    myRole: "admin",
  }),
}))
vi.mock("@/lib/community/channel-ref-extension", () => ({
  toChannelRefCandidate: (_server: unknown, channel: { id: string }) => ({ id: channel.id }),
}))
vi.mock("@/lib/api/client", () => ({ toastApiError: vi.fn() }))
vi.mock("./channel-route-model", () => ({ useChannelRouteModel: () => mocks.route }))
vi.mock("./channel-view", () => ({
  ChannelView: (props: Record<string, any>) => {
    mocks.viewProps = props
    return React.createElement("channel-view")
  },
}))

import { ChannelController } from "./channel-controller"
import { toastApiError } from "@/lib/api/client"

type Renderer = { unmount: () => void; update: (element: React.ReactElement) => void }
const rendererModule = createRequire(import.meta.url)("react-test-renderer") as {
  act: (callback: () => void) => void
  create: (element: React.ReactElement) => Renderer
}
const { act } = rendererModule

const server = {
  id: "server_1",
  name: "Server",
  icon: null,
  categories: [{ channels: [{ id: "channel_1", name: "general", type: "text" }] }],
}

function topLevelRoute() {
  return {
    server,
    channel: server.categories[0].channels[0],
    parent: null,
    currentChannelMeta: null,
    isForum: false,
    isChild: false,
    isForumPostChild: false,
    isNotifyUnit: false,
    routeHydrated: true,
  }
}

describe("ChannelController ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.breakpoint = "desktop"
    mocks.search = "msg=message_1&keep=1"
    mocks.channelNotif = { channel_1: "Nothing" }
    mocks.currentChannelId = "channel_1"
    mocks.route = topLevelRoute()
    mocks.opener = { data: null, isLoading: false }
    mocks.viewProps = null
  })

  it("owns route cleanup, navigation, notification, profile, and text props", () => {
    let renderer: Renderer
    act(() => { renderer = rendererModule.create(<ChannelController serverParam="server_1" channelId="channel_1" />) })
    const view = mocks.viewProps!
    expect(view).toMatchObject({ hydrated: true, isForum: false, isChildChannel: false })
    expect(view.text).toMatchObject({ channelName: "general", anchorMessageId: "message_1" })
    expect(view.text.channelRefCandidates).toEqual([{ id: "channel_1" }])
    expect(mocks.setLastChannel).toHaveBeenCalledWith("server_1", "channel_1")
    expect(mocks.replace).toHaveBeenCalledWith("/c/channels/server_1/channel_1?keep=1", { scroll: false })

    view.text.onOpenThread("thread_1")
    expect(mocks.navigatePath).toHaveBeenCalledWith("/c/channels/server_1/thread_1")
    view.text.onOpenProfile("Alice", { type: "click" }, "0001", "user_1")
    expect(mocks.openProfile).toHaveBeenCalled()
    view.text.onSetNotificationLevel("All")
    const options = mocks.setChannelNotif.mock.calls[0][1]
    options.onError(new Error("denied"))
    expect(toastApiError).toHaveBeenCalledWith(expect.any(Error), "Failed to update notification level")
    act(() => renderer!.unmount())
  })

  it("owns mobile parent navigation and unresolved hydration", () => {
    mocks.breakpoint = "mobile"
    mocks.route = {
      ...topLevelRoute(),
      channel: null,
      currentChannelMeta: { name: "post", parentChannelId: "forum_1", parentMessageId: "opener_1", creatorId: "viewer_1" },
      parent: { id: "forum_1", name: "Forum", type: "forum" },
      isChild: true,
      isForumPostChild: true,
      isNotifyUnit: true,
      routeHydrated: true,
    }
    mocks.opener = { data: { content: "Post title" }, isLoading: true }
    let renderer: Renderer
    act(() => { renderer = rendererModule.create(<ChannelController serverParam="server_1" channelId="channel_1" />) })
    expect(mocks.viewProps).toMatchObject({ hydrated: false, isChildChannel: true })
    expect(mocks.viewProps!.thread).toMatchObject({
      channelName: "Post title",
      parentChannelName: "Forum",
      parentIsForum: true,
      canRenameThread: true,
    })
    mocks.viewProps!.onBack()
    expect(mocks.replacePath).toHaveBeenCalledWith("/c/channels/server_1/forum_1")

    mocks.route = { ...mocks.route, currentChannelMeta: null, parent: null }
    mocks.opener = { data: null, isLoading: false }
    act(() => renderer!.update(<ChannelController serverParam="server_1" channelId="channel_1" />))
    mocks.viewProps!.onBack()
    expect(mocks.goBackMobile).toHaveBeenCalled()
    act(() => renderer!.unmount())
  })

  it("handles a missing server without exposing stale candidates", () => {
    mocks.search = ""
    mocks.channelNotif = {}
    mocks.route = { ...topLevelRoute(), server: null, channel: null, routeHydrated: false }
    act(() => { rendererModule.create(<ChannelController serverParam="server_1" channelId="channel_1" />) })
    expect(mocks.viewProps!.text.channelRefCandidates).toEqual([])
    expect(mocks.viewProps!.text.notificationLevel).toBe("Use Server Default")
    expect(mocks.viewProps!.hydrated).toBe(false)
    expect(mocks.replace).not.toHaveBeenCalled()
  })
})
