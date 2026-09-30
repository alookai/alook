import React from "react"
import { render } from "@/test/react-dom-harness"
import { beforeEach, describe, expect, it, vi } from "vitest"
import DmPage from "./page"

const {
  mockDismissConversation,
  mockDmMessages,
  mockDms,
  mockStore,
} = vi.hoisted(() => ({
  mockDismissConversation: vi.fn(),
  mockDms: {
    dms: [] as Array<{
      id: string
      userId: string
      name: string
      avatar: string
    }>,
    isLoading: false,
  },
  mockDmMessages: {
    navigationBlocked: false,
  },
  mockStore: {
    registerUiHandlers: vi.fn(),
    setCurrentChannelId: vi.fn(),
  },
}))

vi.mock("next/navigation", () => ({
  useParams: () => ({ dmId: "dm_1" }),
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock("sonner", () => ({ toast: vi.fn() }))
vi.mock("@/hooks/use-mobile", () => ({ useBreakpoint: () => "desktop" }))
vi.mock("@/components/community/channels/dm-header", () => ({ DmHeader: () => null }))
vi.mock("@/components/community/channels/dm-loading-frame", () => ({
  DmLoadingFrame: () => React.createElement("div", { "data-testid": "dm-loading" }),
}))
vi.mock("@/components/community/avatar", () => ({ Avatar: () => null }))
vi.mock("@/components/community/messages/message-list", () => ({ MessageList: () => null }))
vi.mock("@/components/community/messages/message-context-sheet", () => ({
  MessageContextSheet: () => null,
}))
vi.mock("@/components/community/messages/composer", () => ({ Composer: () => null }))
vi.mock("@/components/community/messages/conversation-footer-shell", () => ({
  ConversationFooterShell: ({ children }: { children: React.ReactNode }) => children,
  ConversationFooterSlotProvider: ({ children }: { children: React.ReactNode }) => children,
}))
vi.mock("@/stores/community", () => ({
  useCommunityStore: { getState: () => mockStore },
  useUiHandlers: () => ({}),
  useTypingUsersForScope: () => [],
  useTypingNamesForScope: () => ({}),
}))
vi.mock("@/lib/community/testids", () => ({ tid: { dmBlockedNotice: "dm-blocked" } }))
vi.mock("@/lib/community/profile-read", () => ({ readCommunityProfile: vi.fn() }))
vi.mock("@/lib/community/display-name", () => ({
  makeUserNameResolver: () => (userId: string) => userId,
}))
vi.mock("@/hooks/community/use-dms", () => ({ useDms: () => mockDms }))
vi.mock("@/hooks/community/use-friends", () => ({
  useFriends: () => ({ friends: [], blocked: [] }),
}))
vi.mock("@/hooks/community/use-messages", () => ({
  useDmMessages: () => ({
    messages: [],
    isLoading: false,
    hasMoreOlder: false,
    hasMoreNewer: false,
    isFetchingOlder: false,
    isFetchingNewer: false,
    fetchOlder: vi.fn(),
    fetchNewer: vi.fn(),
    jumpToPresent: vi.fn(),
    presentVersion: 0,
    latestSeq: 0,
    isPending: false,
    isError: false,
    refetch: vi.fn(),
    navigationBlocked: mockDmMessages.navigationBlocked,
    anchorReconciled: false,
  }),
}))
vi.mock("@/hooks/community/use-dm-read-state", () => ({
  useDmReadStateSnapshot: () => ({ snapshot: null, isFetching: false }),
}))
vi.mock("@/lib/community/message-read-projection", () => ({
  resolveMessageReadProjection: () => ({ newDividerBefore: undefined, anchorFound: false }),
}))
vi.mock("@/hooks/community/use-dm-watermark", () => ({ useDmWatermark: vi.fn() }))
vi.mock("@/hooks/community/use-channel-ref-directory", () => ({
  useChannelRefDirectory: () => ({
    directory: [],
    isResolved: true,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
}))
vi.mock("@/lib/community/channel-ref-extension", () => ({ toChannelRefCandidate: vi.fn() }))
vi.mock("@/hooks/community/mutations", () => ({
  useAddReactionApi: () => vi.fn(),
  useToggleReactionApi: () => vi.fn(),
  useToggleMark: () => vi.fn(),
  useSetChannelNotif: () => ({ mutate: vi.fn() }),
}))
vi.mock("@/hooks/community/use-dm-message-sender", () => ({
  useDmMessageSender: () => ({ accept: vi.fn(), retry: vi.fn() }),
}))
vi.mock("@/stores/community/message-stream", () => ({
  useMessageStreamStore: { getState: () => ({ dispatch: vi.fn() }) },
}))
vi.mock("@/contexts/community/current-user", () => ({
  useCurrentUser: () => ({ id: "viewer_1", name: "Viewer", avatar: "V" }),
}))
vi.mock("@/hooks/community/use-community-ws", () => ({
  communityWsSubscribe: vi.fn(),
  communityWsUnsubscribe: vi.fn(),
  communityWsSendTyping: vi.fn(),
  communityWsEndTyping: vi.fn(),
}))
vi.mock("@/lib/community-onboarding", () => ({
  advanceCommunityOnboarding: vi.fn(),
  readCommunityOnboardingState: () => null,
}))
vi.mock("@alook/shared", () => ({ notifLevelDisplay: () => "all" }))
vi.mock("@/hooks/community/use-notification-settings", () => ({
  useNotificationSettings: () => ({ channel: {} }),
}))
vi.mock("@/lib/api/client", () => ({ toastApiError: vi.fn() }))
vi.mock("@/lib/community/reply-content", () => ({ displayReplyContent: () => "" }))
vi.mock("@/lib/community-db/projections", () => ({
  useCanonicalProfilesByUserId: () => new Map(),
  useReadStateProjection: () => null,
}))
vi.mock("@/hooks/community/use-native-system-notifications", () => ({
  useNativeSystemNotificationConversationDismissal: (...args: unknown[]) =>
    mockDismissConversation(...args),
}))

describe("DM notification dismissal readiness", () => {
  beforeEach(() => {
    mockDismissConversation.mockClear()
    mockDmMessages.navigationBlocked = false
    mockDms.dms = []
    mockDms.isLoading = false
  })

  it.each([
    ["resolved", [{ id: "dm_1", userId: "peer_1", name: "Peer", avatar: "P" }], false, false, true],
    ["blocked", [{ id: "dm_1", userId: "peer_1", name: "Peer", avatar: "P" }], false, true, false],
    ["pending", [], true, false, false],
    ["notFound", [], false, false, false],
  ] as const)("passes the exact %s readiness state to dismissal", (
    _state,
    dms,
    isLoading,
    navigationBlocked,
    expectedReady,
  ) => {
    mockDms.dms = [...dms]
    mockDms.isLoading = isLoading
    mockDmMessages.navigationBlocked = navigationBlocked

    render(React.createElement(DmPage))

    expect(mockDismissConversation).toHaveBeenCalledExactlyOnceWith(
      "viewer_1",
      { kind: "dm", channelId: "dm_1" },
      expectedReady,
    )
  })
})
