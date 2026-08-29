import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import { describe, expect, it, vi } from "vitest"
import { TextChannelSurface } from "./text-channel-surface"
import { Composer } from "../messages/composer"
import type { MessageChannelControllerValue } from "../messages/message-channel-controller"

const mocks = vi.hoisted(() => ({
  replyTarget: {
    id: "reply_1",
    authorName: "Alice",
    text: "Exact channel target",
  },
}))

vi.mock("@/hooks/use-mobile", () => ({ useBreakpoint: () => "mobile" }))
vi.mock("@/hooks/community/use-channel-message-feed", () => ({
  useChannelMessageFeed: () => ({
    messages: [],
    isLoading: false,
    isFetchingOlder: false,
    isFetchingNewer: false,
    hasMoreOlder: false,
    hasMoreNewer: false,
    fetchOlder: vi.fn(),
    fetchNewer: vi.fn(),
    jumpToPresent: vi.fn(),
    readSnapshotFetching: false,
    anchorInCache: true,
    setScrollRootEl: vi.fn(),
    threads: [],
    pinned: [],
  }),
}))
vi.mock("@/components/community/channels/channel-header", () => ({
  ChannelHeader: () => null,
}))
vi.mock("@/components/community/channels/channel-shell", () => ({
  ChannelShell: ({ body }: { body: React.ReactNode }) => body,
}))
vi.mock("@/components/community/shell/community-panel", () => ({
  CommunityPanel: () => null,
}))
vi.mock("@/components/community/messages/composer", () => ({
  Composer: vi.fn(() => null),
}))
vi.mock("@/components/community/messages/message-context-sheet", () => ({
  MessageContextSheet: () => null,
}))
vi.mock("@/components/community/messages/message-list", () => ({
  MessageList: () => null,
}))
vi.mock("@/components/community/messages/use-author-mention-insertion", () => ({
  useAuthorMentionInsertion: () => ({
    composerRef: { current: null },
    resolveAuthorMentionText: vi.fn(),
    insertMentionText: vi.fn(),
  }),
}))
vi.mock("@/components/community/messages/message-scroll-memory", () => ({
  readMessageScrollPosition: () => undefined,
}))
vi.mock("@/components/community/messages/message-channel-controller", () => ({
  MessageChannelController: ({ children }: {
    children: (value: MessageChannelControllerValue) => React.ReactNode
  }) => children({
    feed: {} as MessageChannelControllerValue["feed"],
    pinnedIds: new Set(),
    replyTo: mocks.replyTarget,
    setReplyTo: vi.fn(),
    searchQuery: "",
    searchResults: [],
    search: vi.fn(),
    scrollTargetId: null,
    setScrollTargetId: vi.fn(),
    consumeScrollTarget: vi.fn(),
    contextTarget: null,
    setContextTarget: vi.fn(),
    openContextSeq: vi.fn(),
    onSheetReply: vi.fn(),
    jumpToSeq: vi.fn(),
    messageActions: {} as MessageChannelControllerValue["messageActions"],
    threadActions: {} as MessageChannelControllerValue["threadActions"],
    acceptMessage: vi.fn(() => true),
    handleTyping: vi.fn(),
    typingUsers: [],
  }),
}))

const mockedComposer = vi.mocked(Composer)

describe("TextChannelSurface reply target wiring", () => {
  it("passes the controller's exact reply target to Composer", () => {
    act(() => {
      TestRenderer.create(React.createElement(TextChannelSurface, {
        channelId: "channel_1",
        serverId: "server_1",
        serverParam: "server_1",
        channelName: "general",
        viewer: { id: "viewer_1", name: "Viewer", avatar: "V" },
        anchorMessageId: null,
        notificationLevel: "default",
        onSetNotificationLevel: vi.fn(),
        composerMembers: [],
        composerMentionCandidates: undefined,
        channelRefCandidates: [],
        memberPanelProps: {
          members: [],
          membersLoading: false,
          membersLoadingMore: false,
          membersHasMore: false,
        },
        manageMembersDialog: null,
        uiHandlers: {},
        onOpenThread: vi.fn(),
        onOpenProfile: vi.fn(),
        resolveUserName: (id: string) => id,
      }))
    })

    expect(mockedComposer.mock.calls.at(-1)?.[0].replyingTo).toBe(mocks.replyTarget)
  })
})
