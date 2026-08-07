import React, { useEffect } from "react"
import TestRenderer, { act } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { AddMembersDialog } from "./add-members-dialog"
import { useChannelMemberViewModel } from "./channel-member-view-model"
import { useAddableMembers, useChannelMembers } from "@/hooks/community/use-channel-members"

const mocks = vi.hoisted(() => ({
  serverMembers: [] as Array<Record<string, unknown>>,
  channelMembers: new Map<string, Array<Record<string, unknown>>>(),
  addableMembers: [] as Array<Record<string, unknown>>,
  onlineUserIds: new Set<string>(),
  userStatuses: new Map<string, { emoji: string | null; text: string }>(),
  serverSearch: vi.fn(),
  loadMore: vi.fn(),
  addChannelMember: vi.fn(),
  removeChannelMember: vi.fn(),
  addThreadParticipant: vi.fn(),
  removeThreadParticipant: vi.fn(),
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
  useChannelMembers: vi.fn((channelId: string) => ({
    members: mocks.channelMembers.get(channelId) ?? [],
    isLoading: false,
  })),
  useAddableMembers: vi.fn(() => ({ members: mocks.addableMembers })),
  useAddChannelMember: () => ({ mutateAsync: mocks.addChannelMember }),
  useRemoveChannelMember: () => ({ mutateAsync: mocks.removeChannelMember }),
}))
vi.mock("@/hooks/community/use-thread-participants", () => ({
  useAddThreadParticipant: () => ({ mutateAsync: mocks.addThreadParticipant }),
  useRemoveThreadParticipant: () => ({ mutateAsync: mocks.removeThreadParticipant }),
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
vi.mock("@/components/community/add-members-dialog", () => ({
  AddMembersDialog: vi.fn(() => null),
}))
vi.mock("@/components/community/community-panel-sheet", () => ({
  CommunityPanelSheet: () => null,
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
    mocks.addableMembers = []
    mocks.onlineUserIds = new Set()
    mocks.userStatuses = new Map()
    mocks.addChannelMember.mockResolvedValue({})
    mocks.removeChannelMember.mockResolvedValue({})
    mocks.addThreadParticipant.mockResolvedValue({})
    mocks.removeThreadParticipant.mockResolvedValue({})
    mocks.kickMember.mockResolvedValue({})
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
    await dialogProps.onAdd("bob_1")
    await latestModel().memberPanelProps.manageContext?.onRemove("alice_1")
    expect(mocks.addThreadParticipant).toHaveBeenCalledWith("bob_1")
    expect(mocks.removeThreadParticipant).toHaveBeenCalledWith("alice_1")
    expect(mocks.addChannelMember).not.toHaveBeenCalled()
    expect(mocks.removeChannelMember).not.toHaveBeenCalled()
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
