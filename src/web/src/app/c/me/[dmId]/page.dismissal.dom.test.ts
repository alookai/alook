import React from "react"
import {  } from "@/test/react-dom-harness"
import { renderCommunity as render } from "@/test/community-owner-harness"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { DmView } from "@/components/community/channels/dm-view"

const {
  mockDismissConversation,
  mockCommitRoute,
  mockDmMessages,
  mockDms,
  mockStore,
  mockHistory,
  mockBlocked,
  mockNavigationGate,
} = vi.hoisted(() => ({
  mockDismissConversation: vi.fn(),
  mockCommitRoute: vi.fn(),
  mockHistory: { allowed: true, denied: false, error: null as Error | null, retry: vi.fn() },
  mockBlocked: [] as Array<{ userId: string }>,
  mockNavigationGate: { allowed: true, failed: false, retry: vi.fn() },
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
  usePathname: () => "/c/me/dm_1",
  useRouter: () => ({ replace: vi.fn() }),
}))
vi.mock("sonner", () => ({ toast: vi.fn() }))
vi.mock("@/hooks/use-mobile", () => ({ useBreakpoint: () => "desktop" }))
vi.mock("@/components/community/channels/dm-header", () => ({
  DmHeader: ({ dm }: { dm: { name: string } }) => React.createElement("div", { "data-testid": "dm-header" }, dm.name),
}))
vi.mock("@/components/community/channels/dm-loading-frame", () => ({
  DmLoadingFrame: () => React.createElement("div", { "data-testid": "dm-loading" }),
}))
vi.mock("@/components/community/channels/dm-route-error-frame", () => ({
  DmRouteErrorFrame: () => React.createElement("div", { "data-testid": "dm-error" }),
}))
vi.mock("@/components/community/channels/conversation-resolution-error-frame", () => ({
  ConversationResolutionErrorFrame: ({ onRetry }: { onRetry: () => void }) => React.createElement("button", { onClick: onRetry, "data-testid": "history-error" }, "Retry"),
}))
vi.mock("@/hooks/community/use-channel-metadata", () => ({
  useChannelMetadata: () => ({ canRead: mockHistory.allowed, denied: mockHistory.denied, data: { readProof: mockHistory.allowed ? {} : undefined } }),
}))
vi.mock("@/lib/community/conversation-navigation-proof", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/community/conversation-navigation-proof")>(),
  useConversationNavigationGate: () => mockNavigationGate,
}))
vi.mock("@/hooks/community/channel-metadata", () => ({ isChannelMetadataTokenCurrent: () => true }))
vi.mock("@/lib/community/last-community-route", () => ({ commitCommunityChannelRoute: mockCommitRoute }))
vi.mock("@/components/community/avatar", () => ({ Avatar: () => null }))
vi.mock("@/components/community/messages/message-list", () => ({ MessageList: () => React.createElement("div", { "data-testid": "history-body" }) }))
vi.mock("@/components/community/messages/message-context-sheet", () => ({
  MessageContextSheet: () => null,
}))
vi.mock("@/components/community/messages/composer", () => ({
  Composer: () => React.createElement("div", { "data-testid": "composer" }),
  ComposerSkeleton: () => React.createElement("div", { "data-testid": "composer-pending" }),
}))
vi.mock("@/components/community/messages/conversation-footer-shell", () => ({
  ConversationFooterShell: ({ children }: { children: React.ReactNode }) => children,
  ConversationFooterSlotProvider: ({ children }: { children: React.ReactNode }) => children,
}))
vi.mock("@/stores/community", async (importOriginal) => ({ ...await importOriginal<typeof import("@/stores/community")>(),
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
  useFriends: () => ({ friends: [], blocked: mockBlocked }),
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
  useDmReadStateSnapshot: () => ({ snapshot: null, isFetching: false, error: mockHistory.error, retry: mockHistory.retry, retrying: false }),
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
vi.mock("@/stores/community/message-stream", async (importOriginal) => ({ ...await importOriginal<typeof import("@/stores/community/message-stream")>(),
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
vi.mock("@alook/shared", async (importOriginal) => ({
  ...await importOriginal<typeof import("@alook/shared")>(), notifLevelDisplay: () => "all" }))
vi.mock("@/hooks/community/use-notification-settings", () => ({
  useNotificationSettings: () => ({ channel: {} }),
}))
vi.mock("@/lib/api/client", () => ({ toastApiError: vi.fn() }))
vi.mock("@/lib/community/reply-content", () => ({ displayReplyContent: () => "" }))
vi.mock("@/lib/community-db/projections", async (importOriginal) => ({ ...await importOriginal<typeof import("@/lib/community-db/projections")>(),
  useCanonicalProfilesByUserId: () => new Map(),
}))
vi.mock("@/hooks/community/use-native-system-notifications", () => ({
  useNativeSystemNotificationConversationDismissal: (...args: unknown[]) =>
    mockDismissConversation(...args),
}))

describe("DM notification dismissal readiness", () => {
  beforeEach(() => {
    mockDismissConversation.mockClear()
    mockCommitRoute.mockClear()
    mockDmMessages.navigationBlocked = false
    mockHistory.allowed = true
    mockHistory.denied = false
    mockHistory.error = null
    mockHistory.retry.mockClear()
    mockBlocked.length = 0
    mockNavigationGate.allowed = true
    mockNavigationGate.failed = false
    mockNavigationGate.retry.mockClear()
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

    render(React.createElement(DmView, { dmId: "dm_1" }))

    expect(mockDismissConversation).toHaveBeenCalledExactlyOnceWith(
      "viewer_1",
      { kind: "dm", channelId: "dm_1" },
      expectedReady,
    )
    if (expectedReady) expect(mockCommitRoute).toHaveBeenCalledExactlyOnceWith("viewer_1", null, "dm_1")
    else expect(mockCommitRoute).not.toHaveBeenCalled()
  })

  it("withholds history/composer and last while read access fails, then permits the same target after retry", () => {
    mockDms.dms = [{ id: "dm_1", userId: "peer_1", name: "Peer", avatar: "P" }]
    mockHistory.allowed = false
    mockHistory.error = Object.assign(new Error("denied"), { status: 403 })
    const view = render(React.createElement(DmView, { dmId: "dm_1" }))
    expect(view.container.querySelector('[data-testid="history-error"]')).not.toBeNull()
    expect(view.container.querySelector('[data-testid="history-body"]')).toBeNull()
    expect(view.container.querySelector('[data-testid="composer"]')).toBeNull()
    expect(mockCommitRoute).not.toHaveBeenCalled()
    view.container.querySelector<HTMLButtonElement>('[data-testid="history-error"]')!.click()
    expect(mockHistory.retry).toHaveBeenCalledOnce()
    mockHistory.allowed = true
    mockHistory.error = null
    view.rerender(React.createElement(DmView, { dmId: "dm_1" }))
    expect(view.container.querySelector('[data-testid="composer"]')).not.toBeNull()
    expect(mockCommitRoute).toHaveBeenCalledExactlyOnceWith("viewer_1", null, "dm_1")
  })

  it.each([
    ["own Block", "pending"],
    ["own Block", "failed"],
    ["denied", "pending"],
    ["denied", "failed"],
  ] as const)("keeps %s terminal state visible over %s navigation and an old read error", (terminal, navigation) => {
    mockDms.dms = [{ id: "dm_1", userId: "peer_1", name: "Peer", avatar: "P" }]
    mockHistory.allowed = false
    mockHistory.denied = terminal === "denied"
    mockHistory.error = new Error("old read failure")
    if (terminal === "own Block") mockBlocked.push({ userId: "peer_1" })
    mockDmMessages.navigationBlocked = true
    mockNavigationGate.allowed = false
    mockNavigationGate.failed = navigation === "failed"

    const view = render(React.createElement(DmView, { dmId: "dm_1" }))

    expect(view.container.querySelector('[data-testid="dm-header"]')?.textContent).toBe("Peer")
    expect(view.container.querySelector('[data-slot="community-conversation-surface"][data-channel-id="dm_1"]')).not.toBeNull()
    for (const testId of ["dm-loading", "dm-error", "history-error", "history-body", "composer", "composer-pending"]) {
      expect(view.container.querySelector(`[data-testid="${testId}"]`)).toBeNull()
    }
    expect(view.container.textContent).not.toContain("Retry")
    if (terminal === "own Block") {
      expect(view.container.querySelector('[data-testid="dm-blocked"]')?.textContent).toContain("You have blocked this user.")
      expect(view.container.querySelector('[role="alert"]')).toBeNull()
    } else {
      expect(view.container.querySelector('[role="alert"]')?.textContent).toBe("You can no longer read this conversation.")
      expect(view.container.querySelector('[data-testid="dm-blocked"]')).toBeNull()
    }
    expect(mockCommitRoute).not.toHaveBeenCalled()
    expect(mockDismissConversation).toHaveBeenCalledExactlyOnceWith("viewer_1", { kind: "dm", channelId: "dm_1" }, false)
    expect(mockHistory.retry).not.toHaveBeenCalled()
    expect(mockNavigationGate.retry).not.toHaveBeenCalled()
  })

  it.each(["pending", "failed"] as const)("retains the %s navigation gate for a readable DM", (navigation) => {
    mockDms.dms = [{ id: "dm_1", userId: "peer_1", name: "Peer", avatar: "P" }]
    mockDmMessages.navigationBlocked = true
    mockNavigationGate.allowed = false
    mockNavigationGate.failed = navigation === "failed"

    const view = render(React.createElement(DmView, { dmId: "dm_1" }))

    expect(view.container.querySelector('[data-testid="dm-header"]')).toBeNull()
    expect(view.container.querySelector('[data-testid="history-body"]')).toBeNull()
    expect(view.container.querySelector('[data-testid="composer"]')).toBeNull()
    expect(view.container.querySelector('[data-testid="dm-blocked"]')).toBeNull()
    expect(view.container.querySelector('[role="alert"]')).toBeNull()
    if (navigation === "pending") {
      expect(view.container.querySelector('[data-testid="dm-loading"]')).not.toBeNull()
      expect(view.container.querySelector('[data-testid="history-error"]')).toBeNull()
    } else {
      expect(view.container.querySelector('[data-testid="dm-loading"]')).toBeNull()
      view.container.querySelector<HTMLButtonElement>('[data-testid="history-error"]')!.click()
      expect(mockNavigationGate.retry).toHaveBeenCalledOnce()
      expect(mockHistory.retry).not.toHaveBeenCalled()
    }
    expect(mockCommitRoute).not.toHaveBeenCalled()
    expect(mockDismissConversation).toHaveBeenCalledExactlyOnceWith("viewer_1", { kind: "dm", channelId: "dm_1" }, false)
  })
})
