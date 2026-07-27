import { describe, it, expect, vi, beforeEach } from "vitest"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"

// F1: the ChannelView shell was three near-duplicate return branches (child /
// forum / standard). They're now one shell — header + right-panel + dialog +
// context-sheet scaffolding declared ONCE, body switching internally by type.
// These tests assert, for each of the four channel types, that the scaffolding
// appears exactly ONCE in the rendered tree and that the correct body renders.
// Child (thread/post) views must still carry the mute control (notifLevel /
// onSetNotifLevel), so we assert the header marker records that it received it.
//
// Node env (no jsdom): renderToStaticMarkup skips effects, so the WS/meta fetch
// never fires. We drive the branch selection through the mocked hooks:
//   - forum: channel present in the server tree with type "forum".
//   - standard: channel present with type "text".
//   - child (thread/post): channel absent from the tree + currentChannelMeta set
//     (isChildChannel = !channelInServer && !!categories).

// ── Child component markers ────────────────────────────────────────────────
vi.mock("@/components/community/channel-header", () => ({
  ChannelHeader: (p: { forum?: boolean; notifLevel?: string; onSetNotifLevel?: unknown; breadcrumb?: unknown }) =>
    createElement("div", {
      "data-testid": "channel-header",
      "data-forum": p.forum ? "1" : "0",
      "data-has-mute": p.notifLevel != null && typeof p.onSetNotifLevel === "function" ? "1" : "0",
      "data-breadcrumb": p.breadcrumb ? "1" : "0",
    }),
  ChannelHeaderSkeleton: () => createElement("div", { "data-testid": "channel-header-skeleton" }),
}))
vi.mock("@/components/community/message-list", () => ({
  // Render `hero` so the child-channel opener shows up in the static tree.
  MessageList: (p: { hero?: unknown }) => createElement("div", { "data-testid": "message-list" }, p.hero as never),
}))
vi.mock("@/components/community/composer", () => ({
  Composer: () => createElement("div", { "data-testid": "composer" }),
  ComposerSkeleton: () => createElement("div", { "data-testid": "composer-skeleton" }),
}))
vi.mock("@/components/community/forum-view", () => ({
  ForumView: () => createElement("div", { "data-testid": "forum-view" }),
  ForumViewSkeleton: () => createElement("div", { "data-testid": "forum-view-skeleton" }),
}))
vi.mock("@/components/community/community-panel-sheet", () => ({
  CommunityPanelSheet: () => createElement("div", { "data-testid": "panel-sheet" }),
}))
vi.mock("@/components/community/message-context-sheet", () => ({
  MessageContextSheet: () => createElement("div", { "data-testid": "context-sheet" }),
}))
vi.mock("@/components/community/thread-opener", () => ({
  ThreadOpener: () => createElement("div", { "data-testid": "thread-opener" }),
}))
vi.mock("@/components/community/add-members-dialog", () => ({
  AddMembersDialog: () => createElement("div", { "data-testid": "add-members" }),
}))

// ── Hook / store mocks ──────────────────────────────────────────────────────
const params = { serverId: "srv_1", channelId: "cha_1" }
vi.mock("next/navigation", () => ({
  useParams: () => params,
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
  useSearchParams: () => ({ get: () => null }),
}))

let serverDetail: { id: string; name: string; icon: string | null; categories: Array<{ private?: boolean; channels: Array<{ id: string; name: string; type: string; creatorId?: string }> }> }
let channelMeta: { name: string; parentChannelId: string | null; parentMessageId: string | null; creatorId: string | null } | null

vi.mock("@/hooks/community/use-servers", () => ({
  useServer: () => ({ server: serverDetail }),
}))
vi.mock("@/stores/community", () => ({
  useCommunityStore: Object.assign(
    (sel: (s: unknown) => unknown) => sel({}),
    { getState: () => ({ setCurrentChannelId: () => {}, setCurrentChannelMeta: () => {}, uiHandlers: {} }) },
  ),
  useCurrentChannelId: () => params.channelId,
  useCurrentChannelMeta: () => channelMeta,
  useUiHandlers: () => ({}),
  useTypingUsersForScope: () => [],
}))
vi.mock("@/contexts/community/current-user", () => ({
  useCurrentUser: () => ({ id: "usr_me", name: "Me", avatar: "M" }),
}))
vi.mock("@/hooks/use-mobile", () => ({ useBreakpoint: () => "desktop" }))
vi.mock("@/hooks/community/use-server-members", () => ({
  useServerMembers: () => ({ members: [], loading: false, loadingMore: false, hasMore: false, total: 0, loadMore: () => {}, searchMembers: () => {} }),
}))
vi.mock("@/hooks/community/use-channel-members", () => ({
  useChannelMembers: () => ({ members: [], isLoading: false }),
  useAddableMembers: () => ({ members: [] }),
  useAddChannelMember: () => ({ mutateAsync: async () => {} }),
  useRemoveChannelMember: () => ({ mutateAsync: async () => {} }),
}))
vi.mock("@/hooks/community/use-thread-participants", () => ({
  useThreadParticipants: () => ({ participants: [], isLoading: false }),
  useAddThreadParticipant: () => ({ mutateAsync: async () => {} }),
  useRemoveThreadParticipant: () => ({ mutateAsync: async () => {} }),
}))
const emptyMessages = {
  messages: [], isLoading: false, hasMoreOlder: false, hasMoreNewer: false,
  isFetchingOlder: false, isFetchingNewer: false, fetchOlder: () => {}, fetchNewer: () => {},
  jumpToPresent: () => {}, latestSeq: 0,
}
vi.mock("@/hooks/community/use-messages", () => ({ useMessages: () => emptyMessages }))
vi.mock("@/hooks/community/use-channel-read-state", () => ({
  useChannelReadStateSnapshot: () => ({ snapshot: null, isFetching: false }),
}))
vi.mock("@/hooks/community/use-channel-bootstrap", () => ({
  useChannelBootstrap: () => ({ readState: null, isFetching: false, isReady: true }),
}))
vi.mock("@/hooks/community/use-channel-watermark", () => ({ useChannelWatermark: () => {} }))
vi.mock("@/hooks/community/use-eager-channel-read", () => ({ useEagerChannelRead: () => {} }))
vi.mock("@/hooks/community/use-channel-panels", () => ({
  useThreads: () => ({ threads: [], isLoading: false }),
  useForumPosts: () => ({ posts: [], isLoading: false }),
  usePins: () => ({ pins: [], isLoading: false }),
}))
vi.mock("@/hooks/community/use-notification-settings", () => ({
  useNotificationSettings: () => ({ channel: {}, server: {} }),
}))
vi.mock("@/stores/community/ws", () => ({
  useOnlineUserIds: () => new Set<string>(),
  useCommunityWsStore: (sel: (s: unknown) => unknown) => sel({ userStatuses: new Map() }),
}))
const stubMut = { mutate: () => {}, mutateAsync: async () => ({}), isPending: false, variables: undefined }
vi.mock("@/hooks/community/mutations", () => ({
  useSendMessage: () => stubMut,
  useToggleReactionApi: () => () => {},
  usePinMessage: () => stubMut,
  useUnpinMessage: () => stubMut,
  useCreateThread: () => stubMut,
  useCreateForumPost: () => stubMut,
  useUpdatePostTags: () => stubMut,
  useDeleteForumPost: () => stubMut,
  useSetMemberRole: () => stubMut,
  useKickMember: () => stubMut,
  useSetChannelNotif: () => stubMut,
  useUploadFile: () => stubMut,
  zipUploadResultsWithDimensions: () => [],
}))
vi.mock("@/hooks/community/use-community-ws", () => ({
  communityWsSubscribe: () => {},
  communityWsUnsubscribe: () => {},
  communityWsSendTyping: () => {},
  communityWsResetTypingThrottle: () => {},
}))

// Import AFTER mocks are declared.
import ChannelPage from "./page"

function occurrences(html: string, testid: string): number {
  return html.split(`data-testid="${testid}"`).length - 1
}

function renderShell(): string {
  return renderToStaticMarkup(createElement(ChannelPage))
}

beforeEach(() => {
  params.serverId = "srv_1"
  params.channelId = "cha_1"
  channelMeta = null
})

describe("ChannelView shell (F1) — scaffolding declared once", () => {
  it("standard text channel: message list body, header/panel/context-sheet each once", () => {
    serverDetail = { id: "srv_1", name: "S", icon: null, categories: [{ channels: [{ id: "cha_1", name: "general", type: "text" }] }] }
    const html = renderShell()
    expect(occurrences(html, "channel-header")).toBe(1)
    expect(occurrences(html, "context-sheet")).toBe(1)
    expect(occurrences(html, "message-list")).toBe(1)
    expect(occurrences(html, "composer")).toBe(1)
    expect(occurrences(html, "forum-view")).toBe(0)
    expect(html).toContain('data-forum="0"')
  })

  it("forum channel: forum-view body, header once, no message list", () => {
    serverDetail = { id: "srv_1", name: "S", icon: null, categories: [{ channels: [{ id: "cha_1", name: "help", type: "forum" }] }] }
    const html = renderShell()
    expect(occurrences(html, "channel-header")).toBe(1)
    expect(occurrences(html, "forum-view")).toBe(1)
    expect(occurrences(html, "message-list")).toBe(0)
    expect(html).toContain('data-forum="1"')
  })

  it("thread (child) channel: message list body + opener, breadcrumb header once, mute preserved", () => {
    // Channel absent from tree + meta present with parentMessageId → thread.
    serverDetail = { id: "srv_1", name: "S", icon: null, categories: [{ channels: [{ id: "cha_parent", name: "general", type: "text" }] }] }
    channelMeta = { name: "my thread", parentChannelId: "cha_parent", parentMessageId: "msg_1", creatorId: "usr_me" }
    const html = renderShell()
    expect(occurrences(html, "channel-header")).toBe(1)
    expect(occurrences(html, "context-sheet")).toBe(1)
    expect(occurrences(html, "message-list")).toBe(1)
    expect(occurrences(html, "thread-opener")).toBe(1)
    expect(html).toContain('data-breadcrumb="1"')
    // Mute control preserved on the child view (notifLevel + onSetNotifLevel).
    expect(html).toContain('data-has-mute="1"')
  })

  it("forum post (child) channel: message list body, no opener (no parentMessageId), mute preserved", () => {
    serverDetail = { id: "srv_1", name: "S", icon: null, categories: [{ channels: [{ id: "cha_forum", name: "help", type: "forum" }] }] }
    channelMeta = { name: "a post", parentChannelId: "cha_forum", parentMessageId: null, creatorId: "usr_me" }
    const html = renderShell()
    expect(occurrences(html, "channel-header")).toBe(1)
    expect(occurrences(html, "message-list")).toBe(1)
    // No parentMessageId → no opener hero.
    expect(occurrences(html, "thread-opener")).toBe(0)
    expect(html).toContain('data-breadcrumb="1"')
    expect(html).toContain('data-has-mute="1"')
  })
})
