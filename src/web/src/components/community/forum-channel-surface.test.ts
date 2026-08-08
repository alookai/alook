import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ChannelHeader } from "./channel-header"
import { CommunityPanelSheet } from "./community-panel-sheet"
import { ForumChannelSurface } from "./forum-channel-surface"
import { ForumSurface } from "./forum-surface"

const mocks = vi.hoisted(() => ({
  createForumThread: vi.fn(),
  updatePostTags: vi.fn(),
  deleteForumThread: vi.fn(),
  readState: vi.fn(() => ({ snapshot: null, isFetching: false })),
  eagerRead: vi.fn(),
  activeMessageFeed: vi.fn(() => { throw new Error("forum must not initialize an active message feed") }),
}))

vi.mock("@/lib/api/client", () => ({ toastApiError: vi.fn() }))
vi.mock("@/hooks/community/use-channel-message-feed", () => ({
  useChannelMessageFeed: mocks.activeMessageFeed,
}))
vi.mock("@/hooks/community/use-channel-read-state", () => ({
  useChannelReadStateSnapshot: mocks.readState,
}))
vi.mock("@/hooks/community/use-eager-channel-read", () => ({
  useEagerChannelRead: mocks.eagerRead,
}))
vi.mock("@/hooks/community/mutations", () => ({
  useCreateForumThread: () => ({ mutateAsync: mocks.createForumThread }),
  useUpdatePostTags: () => ({
    mutate: mocks.updatePostTags,
    isPending: true,
    variables: { threadId: "post_saving" },
  }),
  useDeleteForumThread: () => ({
    mutate: mocks.deleteForumThread,
    isPending: true,
    variables: { threadId: "post_deleting" },
  }),
}))
vi.mock("@/components/community/_types", async (importOriginal) => {
  const original = await importOriginal<typeof import("./_types")>()
  return { ...original, canManageServer: (role: string | undefined) => role === "owner" || role === "admin" }
})
vi.mock("@/components/community/channel-header", () => ({
  ChannelHeader: vi.fn(() => null),
}))
vi.mock("@/components/community/channel-shell", () => ({
  ChannelShell: ({ header, body, panels, dialogs }: {
    header: React.ReactNode
    body: React.ReactNode
    panels?: React.ReactNode
    dialogs?: React.ReactNode
  }) => React.createElement(React.Fragment, null, header, body, panels, dialogs),
}))
vi.mock("@/components/community/community-panel-sheet", () => ({
  CommunityPanelSheet: vi.fn(() => null),
}))
vi.mock("@/components/community/forum-surface", () => ({
  ForumSurface: vi.fn(() => null),
}))

const mockedChannelHeader = vi.mocked(ChannelHeader)
const mockedCommunityPanelSheet = vi.mocked(CommunityPanelSheet)
const mockedForumSurface = vi.mocked(ForumSurface)

function surfaceProps(overrides: Record<string, unknown> = {}) {
  return {
    channelId: "forum_1",
    serverId: "srv_1",
    channelName: "ideas",
    viewer: { id: "viewer_1" },
    viewerRole: "member" as const,
    notificationLevel: "Use Server Default" as const,
    onSetNotificationLevel: vi.fn(),
    composerMembers: [],
    onSearchComposerMembers: vi.fn(),
    memberPanelProps: { members: [] },
    manageMembersDialog: React.createElement("span", { "data-manage-dialog": true }),
    onOpenPost: vi.fn(),
    onOpenProfile: vi.fn(),
    ...overrides,
  }
}

describe("ForumChannelSurface ownership", () => {
  beforeEach(() => {
    mocks.createForumThread.mockResolvedValue({ threadId: "post_new" })
    mocks.readState.mockReturnValue({ snapshot: null, isFetching: false })
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it("owns forum create, tag, delete, permissions, and pending wiring without an active message feed", async () => {
    const props = surfaceProps()
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(React.createElement(ForumChannelSurface, props))
    })

    expect(mocks.activeMessageFeed).not.toHaveBeenCalled()
    const forumProps = mockedForumSurface.mock.calls.at(-1)![0]
    expect(forumProps).toEqual(expect.objectContaining({
      forumChannelId: "forum_1",
      members: props.composerMembers,
      onSearchMembers: props.onSearchComposerMembers,
      onOpenPost: props.onOpenPost,
      savingTagsFor: "post_saving",
      deletingPost: "post_deleting",
    }))
    const ownPost = {
      id: "post_1",
      authorId: "viewer_1",
      openerMessageId: "opener_1",
    } as Parameters<NonNullable<typeof forumProps.canEditPostTags>>[0]
    const otherPost = { ...ownPost, authorId: "other_1" }
    expect(forumProps.canEditPostTags?.(ownPost)).toBe(true)
    expect(forumProps.canEditPostTags?.(otherPost)).toBe(false)
    expect(forumProps.canDeletePost?.(ownPost)).toBe(true)
    expect(forumProps.canDeletePost?.(otherPost)).toBe(false)

    await forumProps.onCreatePost?.({
      nonce: "nonce_1",
      name: "New post",
      content: "Body",
      attachments: [],
      mentionType: "everyone",
    })
    expect(mocks.createForumThread).toHaveBeenCalledWith({
      nonce: "nonce_1",
      channelId: "forum_1",
      name: "New post",
      content: "Body",
      attachments: [],
      mentionType: "everyone",
    })
    expect(props.onOpenPost).toHaveBeenCalledWith("post_new")

    act(() => {
      forumProps.onEditPostTags?.(ownPost, ["shipped"])
      forumProps.onDeletePost?.(ownPost)
    })
    expect(mocks.updatePostTags).toHaveBeenCalledWith({
      forumChannelId: "forum_1",
      threadId: "post_1",
      openerMessageId: "opener_1",
      tags: ["shipped"],
    }, expect.any(Object))
    expect(mocks.deleteForumThread).toHaveBeenCalledWith({
      forumChannelId: "forum_1",
      serverId: "srv_1",
      threadId: "post_1",
    }, expect.any(Object))
    expect(renderer!.root.findByProps({ "data-manage-dialog": true })).toBeTruthy()
  })

  it("allows server managers to edit and delete other authors' posts", () => {
    act(() => {
      TestRenderer.create(React.createElement(ForumChannelSurface, surfaceProps({ viewerRole: "admin" })))
    })
    const forumProps = mockedForumSurface.mock.calls.at(-1)![0]
    const otherPost = { id: "post_2", authorId: "other_1", openerMessageId: "opener_2" } as Parameters<NonNullable<typeof forumProps.canEditPostTags>>[0]
    expect(forumProps.canEditPostTags?.(otherPost)).toBe(true)
    expect(forumProps.canDeletePost?.(otherPost)).toBe(true)
  })

  it("waits for the read snapshot and eagerly reads each forum without an active message feed", () => {
    mocks.readState.mockReturnValue({ snapshot: null, isFetching: true })
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(React.createElement(ForumChannelSurface, surfaceProps()))
    })

    expect(mocks.readState).toHaveBeenLastCalledWith("forum_1")
    expect(mocks.eagerRead).toHaveBeenLastCalledWith({
      channelId: "forum_1",
      serverId: "srv_1",
      isChildChannel: false,
      snapshotReady: false,
    })

    mocks.readState.mockReturnValue({ snapshot: null, isFetching: false })
    act(() => {
      renderer!.update(React.createElement(ForumChannelSurface, surfaceProps()))
    })
    expect(mocks.eagerRead).toHaveBeenLastCalledWith({
      channelId: "forum_1",
      serverId: "srv_1",
      isChildChannel: false,
      snapshotReady: true,
    })

    act(() => {
      renderer!.update(React.createElement(
        ForumChannelSurface,
        surfaceProps({ channelId: "forum_2", serverId: "srv_2" }),
      ))
    })
    expect(mocks.readState).toHaveBeenLastCalledWith("forum_2")
    expect(mocks.eagerRead).toHaveBeenLastCalledWith({
      channelId: "forum_2",
      serverId: "srv_2",
      isChildChannel: false,
      snapshotReady: true,
    })
    expect(mocks.activeMessageFeed).not.toHaveBeenCalled()
  })

  it("resets the right panel when channelId changes without relying on an outer remount", () => {
    const firstProps = surfaceProps()
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(React.createElement(ForumChannelSurface, firstProps))
    })
    act(() => {
      mockedChannelHeader.mock.calls.at(-1)![0].onToggle("members")
    })
    expect(mockedCommunityPanelSheet.mock.calls.at(-1)![0]).toEqual(expect.objectContaining({ kind: "members" }))

    act(() => {
      renderer!.update(React.createElement(
        ForumChannelSurface,
        surfaceProps({ channelId: "forum_2", channelName: "roadmap" }),
      ))
    })

    expect(mockedChannelHeader.mock.calls.at(-1)![0].rightPanel).toBeNull()
    expect(renderer!.root.findAllByType(CommunityPanelSheet)).toHaveLength(0)
  })
})
