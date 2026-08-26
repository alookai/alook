import React, { useEffect } from "react"
import TestRenderer, { act } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { AddMembersDialog } from "./add-members-dialog"
import { useChannelMemberViewModel } from "./channel-member-view-model"
import { useAddableMembers, useChannelMembers } from "@/hooks/community/use-channel-members"

const mocks = vi.hoisted(() => ({
  serverMembers: [] as Array<Record<string, unknown>>,
  channelMembers: new Map<string, Array<Record<string, unknown>>>(),
  channelQueryState: new Map<string, {
    resolved?: boolean
    isLoading?: boolean
    isError?: boolean
    isFetching?: boolean
  }>(),
  channelRefetches: new Map<string, ReturnType<typeof vi.fn>>(),
  addableMembers: [] as Array<Record<string, unknown>>,
  addableResolved: true,
  addableLoading: false,
  addableError: false,
  addableFetching: false,
  addableRefetch: vi.fn(),
  onlineUserIds: new Set<string>(),
  userStatuses: new Map<string, { emoji: string | null; text: string }>(),
  serverSearch: vi.fn(),
  loadMore: vi.fn(),
  addChannelMember: vi.fn(),
  removeChannelMember: vi.fn(),
  addThreadParticipant: vi.fn(),
  removeThreadParticipant: vi.fn(),
  addThreadHookArgs: [] as unknown[][],
  removeThreadHookArgs: [] as unknown[][],
  setMemberRole: vi.fn(),
  kickMember: vi.fn(),
}))

vi.mock("sonner", () => ({ toast: vi.fn() }))
vi.mock("@/lib/api/client", () => ({ toastApiError: vi.fn() }))
vi.mock("@/hooks/community/use-server-members", () => ({
  useServerMembers: () => ({
    members: mocks.serverMembers,
    loading: false,
    loadingMore: false,
    hasMore: true,
    loadMore: mocks.loadMore,
    searchMembers: mocks.serverSearch,
  }),
}))
vi.mock("@/hooks/community/use-channel-members", () => ({
  useChannelMembers: vi.fn((channelId: string, enabled = true) => {
    const members = mocks.channelMembers.get(channelId) ?? []
    const state = mocks.channelQueryState.get(channelId)
    const resolved = enabled && (state?.resolved ?? mocks.channelMembers.has(channelId))
    let refetch = mocks.channelRefetches.get(channelId)
    if (!refetch) {
      refetch = vi.fn().mockResolvedValue({})
      mocks.channelRefetches.set(channelId, refetch)
    }
    return {
      members,
      data: resolved ? { members } : undefined,
      isLoading: state?.isLoading ?? (enabled && !resolved && !state?.isError),
      isError: state?.isError ?? false,
      isFetching: state?.isFetching ?? false,
      refetch,
    }
  }),
  useAddableMembers: vi.fn((_serverId: string, _channelId: string, enabled = true) => ({
    members: mocks.addableMembers,
    data: enabled && mocks.addableResolved ? { members: mocks.addableMembers } : undefined,
    isLoading: enabled && mocks.addableLoading,
    isError: enabled && mocks.addableError,
    isFetching: enabled && mocks.addableFetching,
    refetch: mocks.addableRefetch,
  })),
  useAddChannelMember: () => ({ mutateAsync: mocks.addChannelMember }),
  useRemoveChannelMember: () => ({ mutateAsync: mocks.removeChannelMember }),
}))
vi.mock("@/hooks/community/use-thread-participants", () => ({
  useAddThreadParticipant: (...args: unknown[]) => {
    mocks.addThreadHookArgs.push(args)
    return { mutateAsync: mocks.addThreadParticipant }
  },
  useRemoveThreadParticipant: (...args: unknown[]) => {
    mocks.removeThreadHookArgs.push(args)
    return { mutateAsync: mocks.removeThreadParticipant }
  },
}))
vi.mock("@/hooks/community/mutations", () => ({
  useSetMemberRole: () => ({ mutate: mocks.setMemberRole }),
  useKickMember: () => ({ mutateAsync: mocks.kickMember }),
}))
vi.mock("@/stores/community/ws", () => ({
  useOnlineUserIds: () => mocks.onlineUserIds,
  useCommunityWsStore: (selector: (state: { userStatuses: typeof mocks.userStatuses }) => unknown) =>
    selector({ userStatuses: mocks.userStatuses }),
}))
vi.mock("@/components/community/members/add-members-dialog", () => ({
  AddMembersDialog: vi.fn(() => null),
}))
vi.mock("@/components/community/shell/community-panel", () => ({
  CommunityPanel: () => null,
}))

const mockedAddMembersDialog = vi.mocked(AddMembersDialog)
const mockedUseAddableMembers = vi.mocked(useAddableMembers)
const mockedUseChannelMembers = vi.mocked(useChannelMembers)

function member(userId: string, name: string, overrides: Record<string, unknown> = {}) {
  return {
    id: `member_${userId}`,
    userId,
    name,
    discriminator: "0001",
    avatar: name.slice(0, 1),
    status: "offline",
    sub: "",
    role: "member",
    statusEmoji: null,
    statusText: "",
    source: "explicit",
    isCreator: false,
    ...overrides,
  }
}

function props(overrides: Record<string, unknown> = {}) {
  return {
    serverId: "server_1",
    channelId: "channel_1",
    channelName: "general",
    currentServer: {
      categories: [{ private: false, channels: [{ id: "channel_1" }, { id: "channel_2" }] }],
    },
    channelInServer: { creatorId: "viewer_1" },
    currentChannelMeta: null,
    isChildChannel: false,
    isNotifyUnit: false,
    currentUser: { id: "viewer_1" },
    ...overrides,
  }
}

const captureModel = vi.fn()

function Harness({ modelProps }: { modelProps: ReturnType<typeof props> }) {
  const model = useChannelMemberViewModel(modelProps)
  useEffect(() => {
    captureModel(model)
  }, [model])
  return model.manageMembersDialog
}

function renderHarness(modelProps: ReturnType<typeof props>) {
  return React.createElement(Harness, { modelProps })
}

function latestModel(): ReturnType<typeof useChannelMemberViewModel> {
  return captureModel.mock.calls.at(-1)![0]
}

describe("useChannelMemberViewModel", () => {
  beforeEach(() => {
    mocks.serverMembers = [
      member("viewer_1", "Viewer", { role: "admin" }),
      member("alice_1", "Alice"),
    ]
    mocks.channelMembers = new Map()
    mocks.channelQueryState = new Map()
    mocks.channelRefetches = new Map()
    mocks.addableMembers = []
    mocks.addableResolved = true
    mocks.addableLoading = false
    mocks.addableError = false
    mocks.addableFetching = false
    mocks.addableRefetch.mockReset()
    mocks.addableRefetch.mockResolvedValue({})
    mocks.onlineUserIds = new Set()
    mocks.userStatuses = new Map()
    mocks.addChannelMember.mockResolvedValue({})
    mocks.removeChannelMember.mockResolvedValue({})
    mocks.addThreadParticipant.mockResolvedValue({})
    mocks.removeThreadParticipant.mockResolvedValue({})
    mocks.addThreadHookArgs = []
    mocks.removeThreadHookArgs = []
    mocks.kickMember.mockResolvedValue({})
  })

  it("scopes forum sidebar participant mutations only to children of a forum", () => {
    const child = (parentType: string) => props({
      channelId: "thread_1",
      currentServer: {
        categories: [{
          private: false,
          channels: [{ id: "parent_1", type: parentType }],
        }],
      },
      channelInServer: null,
      currentChannelMeta: { name: "Thread", parentChannelId: "parent_1" },
      isChildChannel: true,
      isNotifyUnit: true,
    })
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(renderHarness(child("text")))
    })
    expect(mocks.addThreadHookArgs.at(-1)).toEqual(["thread_1", undefined, "viewer_1"])
    expect(mocks.removeThreadHookArgs.at(-1)).toEqual(["thread_1", "server_1", "viewer_1", false])

    act(() => {
      renderer!.update(renderHarness(child("forum")))
    })
    expect(mocks.addThreadHookArgs.at(-1)).toEqual(["thread_1", "server_1", "viewer_1"])
    expect(mocks.removeThreadHookArgs.at(-1)).toEqual(["thread_1", "server_1", "viewer_1", true])
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it("uses the public server roster, excludes self, and keeps the raw-roster resolver stable across presence ticks", () => {
    const modelProps = props()
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(renderHarness(modelProps))
    })

    expect(latestModel().memberPanelProps.members.map((row) => row.userId)).toEqual(["viewer_1", "alice_1"])
    expect(latestModel().composerMembers.map((row) => row.userId)).toEqual(["alice_1"])
    expect(latestModel().memberPanelProps.onSearchMembers).toBe(mocks.serverSearch)
    expect(latestModel().memberPanelProps.onAddMember).toBeUndefined()
    expect(latestModel().myRole).toBe("admin")
    const resolver = latestModel().resolveUserName
    expect(resolver("alice_1")).toBe("Alice")

    mocks.onlineUserIds = new Set(["alice_1"])
    mocks.userStatuses = new Map([["alice_1", { emoji: "🌱", text: "Focused" }]])
    act(() => {
      renderer!.update(renderHarness(modelProps))
    })

    expect(latestModel().resolveUserName).toBe(resolver)
    expect(latestModel().memberPanelProps.members.find((row) => row.userId === "alice_1")).toEqual(
      expect.objectContaining({ status: "online", statusEmoji: "🌱", statusText: "Focused" }),
    )
  })

  it("keeps the private addable query lazy and resets search and dialog state when the channel changes", () => {
    mocks.channelMembers.set("channel_1", [member("viewer_1", "Viewer"), member("alice_1", "Alice")])
    mocks.channelMembers.set("channel_2", [member("viewer_1", "Viewer"), member("bob_1", "Bob")])
    mocks.addableMembers = [member("carol_1", "Carol")]
    const privateServer = {
      categories: [{ private: true, channels: [{ id: "channel_1" }, { id: "channel_2" }] }],
    }
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(renderHarness(props({ currentServer: privateServer })))
    })
    expect(mockedUseAddableMembers).toHaveBeenLastCalledWith("server_1", "channel_1", false)

    act(() => {
      latestModel().memberPanelProps.onSearchMembers?.("alice")
      latestModel().memberPanelProps.onAddMember?.()
    })
    expect(mockedUseAddableMembers).toHaveBeenLastCalledWith("server_1", "channel_1", true)
    expect(mockedAddMembersDialog).toHaveBeenCalledWith(expect.objectContaining({
      title: "Add members to /general",
    }), undefined)

    act(() => {
      renderer!.update(renderHarness(props({
        channelId: "channel_2",
        channelName: "random",
        currentServer: privateServer,
      })))
    })

    expect(mockedUseAddableMembers).toHaveBeenLastCalledWith("server_1", "channel_2", false)
    expect(mockedUseAddableMembers).not.toHaveBeenCalledWith("server_1", "channel_2", true)
    expect(latestModel().manageMembersDialog).toBeNull()
    expect(latestModel().memberPanelProps.members.map((row) => row.userId)).toEqual(["viewer_1", "bob_1"])
  })

  it("routes private audience management only through channel-member mutations", async () => {
    mocks.channelMembers.set("channel_1", [member("viewer_1", "Viewer"), member("alice_1", "Alice")])
    act(() => {
      TestRenderer.create(renderHarness(props({
        currentServer: { categories: [{ private: true, channels: [{ id: "channel_1" }] }] },
      })))
    })

    await latestModel().memberPanelProps.manageContext?.onRemove("alice_1")
    expect(mocks.removeChannelMember).toHaveBeenCalledWith("alice_1")
    expect(mocks.removeThreadParticipant).not.toHaveBeenCalled()
    expect(latestModel().memberPanelProps.manageContext).toEqual(expect.objectContaining({
      viewerUserId: "viewer_1",
      viewerIsCreator: true,
      unitLabel: "general",
    }))
  })

  it("uses participants for the notify panel and the parent roster for mentions and add candidates", async () => {
    mocks.channelMembers.set("thread_1", [
      member("viewer_1", "Viewer", { isCreator: true }),
      member("alice_1", "Alice"),
    ])
    mocks.channelMembers.set("parent_1", [
      member("viewer_1", "Viewer"),
      member("alice_1", "Alice"),
      member("bob_1", "Bob"),
    ])
    act(() => {
      TestRenderer.create(renderHarness(props({
        channelId: "thread_1",
        channelName: "topic",
        currentServer: { categories: [{ private: true, channels: [{ id: "parent_1" }] }] },
        channelInServer: null,
        currentChannelMeta: { name: "topic", parentChannelId: "parent_1", creatorId: "viewer_1" },
        isChildChannel: true,
        isNotifyUnit: true,
      })))
    })

    expect(mockedUseChannelMembers).toHaveBeenCalledWith("thread_1", true)
    expect(mockedUseChannelMembers).toHaveBeenCalledWith("parent_1", true)
    expect(latestModel().memberPanelProps.members.map((row) => row.userId)).toEqual(["viewer_1", "alice_1"])
    expect(latestModel().memberPanelProps.members.every((row) => row.source === undefined)).toBe(true)
    expect(latestModel().composerMembers.map((row) => row.userId)).toEqual(["alice_1", "bob_1"])

    act(() => {
      latestModel().memberPanelProps.onAddMember?.()
    })
    const dialogProps = mockedAddMembersDialog.mock.calls.at(-1)![0]
    expect(dialogProps.candidates).toEqual([
      expect.objectContaining({ userId: "bob_1", name: "Bob" }),
    ])
    expect(dialogProps.queryState).toEqual(expect.objectContaining({
      resolved: true,
      loading: false,
      error: false,
      retrying: false,
    }))
    await dialogProps.onAdd("bob_1")
    await latestModel().memberPanelProps.manageContext?.onRemove("alice_1")
    expect(mocks.addThreadParticipant).toHaveBeenCalledWith("bob_1")
    expect(mocks.removeThreadParticipant).toHaveBeenCalledWith("alice_1")
    expect(mocks.addChannelMember).not.toHaveBeenCalled()
    expect(mocks.removeChannelMember).not.toHaveBeenCalled()
  })

  it("gates thread candidates on both query sources and retries only unresolved sources", () => {
    mocks.channelMembers.set("thread_1", [
      member("viewer_1", "Viewer", { isCreator: true }),
      member("alice_1", "Alice"),
    ])
    mocks.channelMembers.set("parent_1", [
      member("viewer_1", "Viewer"),
      member("alice_1", "Alice"),
      member("bob_1", "Bob"),
    ])
    mocks.channelQueryState.set("thread_1", { resolved: false, isLoading: true })
    mocks.channelQueryState.set("parent_1", { resolved: false, isLoading: true })
    const participantRefetch = vi.fn().mockResolvedValue({})
    const parentRefetch = vi.fn().mockResolvedValue({})
    mocks.channelRefetches.set("thread_1", participantRefetch)
    mocks.channelRefetches.set("parent_1", parentRefetch)
    const modelProps = props({
      channelId: "thread_1",
      channelName: "topic",
      currentServer: { categories: [{ private: true, channels: [{ id: "parent_1" }] }] },
      channelInServer: null,
      currentChannelMeta: { name: "topic", parentChannelId: "parent_1", creatorId: "viewer_1" },
      isChildChannel: true,
      isNotifyUnit: true,
    })
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(renderHarness(modelProps))
    })
    act(() => {
      latestModel().memberPanelProps.onAddMember?.()
    })

    let dialogProps = mockedAddMembersDialog.mock.calls.at(-1)![0]
    expect(dialogProps.candidates).toEqual([])
    expect(dialogProps.queryState).toEqual(expect.objectContaining({
      resolved: false,
      loading: true,
      error: false,
    }))
    act(() => dialogProps.queryState.retry())
    expect(participantRefetch).toHaveBeenCalledTimes(1)
    expect(parentRefetch).toHaveBeenCalledTimes(1)

    participantRefetch.mockClear()
    parentRefetch.mockClear()
    mocks.channelQueryState.set("thread_1", { resolved: false, isError: true })
    mocks.channelQueryState.set("parent_1", { resolved: true })
    act(() => {
      renderer!.update(renderHarness(modelProps))
    })

    dialogProps = mockedAddMembersDialog.mock.calls.at(-1)![0]
    expect(dialogProps.candidates).toEqual([])
    expect(dialogProps.queryState).toEqual(expect.objectContaining({
      resolved: false,
      loading: false,
      error: true,
    }))
    act(() => dialogProps.queryState.retry())
    expect(participantRefetch).toHaveBeenCalledTimes(1)
    expect(parentRefetch).not.toHaveBeenCalled()

    participantRefetch.mockClear()
    parentRefetch.mockClear()
    mocks.channelQueryState.set("thread_1", { resolved: true })
    mocks.channelQueryState.set("parent_1", { resolved: false, isLoading: true })
    act(() => {
      renderer!.update(renderHarness(modelProps))
    })

    dialogProps = mockedAddMembersDialog.mock.calls.at(-1)![0]
    expect(dialogProps.candidates).toEqual([])
    expect(dialogProps.queryState).toEqual(expect.objectContaining({
      resolved: false,
      loading: true,
      error: false,
    }))
    act(() => dialogProps.queryState.retry())
    expect(participantRefetch).not.toHaveBeenCalled()
    expect(parentRefetch).toHaveBeenCalledTimes(1)

    participantRefetch.mockClear()
    parentRefetch.mockClear()
    mocks.channelQueryState.set("parent_1", { resolved: false, isError: true })
    act(() => {
      renderer!.update(renderHarness(modelProps))
    })

    dialogProps = mockedAddMembersDialog.mock.calls.at(-1)![0]
    expect(dialogProps.candidates).toEqual([])
    expect(dialogProps.queryState).toEqual(expect.objectContaining({
      resolved: false,
      loading: false,
      error: true,
    }))
    act(() => dialogProps.queryState.retry())
    expect(participantRefetch).not.toHaveBeenCalled()
    expect(parentRefetch).toHaveBeenCalledTimes(1)
  })

  it("keeps composite candidates usable during a cached participant background error", () => {
    mocks.channelMembers.set("thread_1", [
      member("viewer_1", "Viewer", { isCreator: true }),
      member("alice_1", "Alice"),
    ])
    mocks.channelMembers.set("parent_1", [
      member("viewer_1", "Viewer"),
      member("alice_1", "Alice"),
      member("bob_1", "Bob"),
    ])
    mocks.channelQueryState.set("thread_1", {
      resolved: true,
      isError: true,
      isFetching: true,
    })
    mocks.channelQueryState.set("parent_1", { resolved: true })
    act(() => {
      TestRenderer.create(renderHarness(props({
        channelId: "thread_1",
        channelName: "topic",
        currentServer: { categories: [{ private: true, channels: [{ id: "parent_1" }] }] },
        channelInServer: null,
        currentChannelMeta: { name: "topic", parentChannelId: "parent_1", creatorId: "viewer_1" },
        isChildChannel: true,
        isNotifyUnit: true,
      })))
    })
    act(() => {
      latestModel().memberPanelProps.onAddMember?.()
    })

    const dialogProps = mockedAddMembersDialog.mock.calls.at(-1)![0]
    expect(dialogProps.candidates.map((candidate) => candidate.userId)).toEqual(["bob_1"])
    expect(dialogProps.queryState).toEqual(expect.objectContaining({
      resolved: true,
      loading: false,
      error: false,
      retrying: false,
    }))
  })

  it("preserves server role and kick mutation wiring", async () => {
    act(() => {
      TestRenderer.create(renderHarness(props()))
    })

    latestModel().memberPanelProps.onSetRole?.("member_alice", "admin")
    await latestModel().memberPanelProps.onKickMember?.("member_alice")
    expect(mocks.setMemberRole).toHaveBeenCalledWith({
      serverId: "server_1",
      memberId: "member_alice",
      role: "admin",
    }, expect.any(Object))
    expect(mocks.kickMember).toHaveBeenCalledWith({ serverId: "server_1", memberId: "member_alice" })
  })
})
