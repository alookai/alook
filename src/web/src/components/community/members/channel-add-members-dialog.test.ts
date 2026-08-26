import { createElement } from "react"
import TestRenderer, { act } from "react-test-renderer"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { AddMembersDialog } from "./add-members-dialog"
import { ChannelAddMembersDialog } from "./channel-add-members-dialog"

const mocks = vi.hoisted(() => ({
  members: [{ userId: "user_1", name: "Alice", avatar: "A" }],
  data: undefined as { members: Array<{ userId: string; name: string; avatar: string }> } | undefined,
  isLoading: true,
  isError: false,
  isFetching: true,
  refetch: vi.fn(),
  add: vi.fn(),
}))

vi.mock("@/hooks/community/use-channel-members", () => ({
  useAddableMembers: () => ({
    members: mocks.members,
    data: mocks.data,
    isLoading: mocks.isLoading,
    isError: mocks.isError,
    isFetching: mocks.isFetching,
    refetch: mocks.refetch,
  }),
  useAddChannelMember: () => ({ mutateAsync: mocks.add }),
}))
vi.mock("./add-members-dialog", () => ({
  AddMembersDialog: vi.fn(() => null),
}))

const mockedDialog = vi.mocked(AddMembersDialog)

describe("ChannelAddMembersDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.data = undefined
    mocks.isLoading = true
    mocks.isError = false
    mocks.isFetching = true
    mocks.refetch.mockResolvedValue({})
    mocks.add.mockResolvedValue({})
  })

  it("forwards unresolved addable-member state and Retry", () => {
    act(() => {
      TestRenderer.create(createElement(ChannelAddMembersDialog, {
        serverId: "server_1",
        channelId: "channel_1",
        channelName: "private",
        onClose: vi.fn(),
      }))
    })

    const props = mockedDialog.mock.calls.at(-1)![0]
    expect(props.candidates).toEqual(mocks.members)
    expect(props.queryState).toEqual(expect.objectContaining({
      resolved: false,
      loading: true,
      error: false,
      retrying: true,
    }))
    act(() => props.queryState.retry())
    expect(mocks.refetch).toHaveBeenCalledTimes(1)
  })

  it("treats cached data as resolved during a background error", () => {
    mocks.data = { members: mocks.members }
    mocks.isLoading = false
    mocks.isError = true
    mocks.isFetching = true
    act(() => {
      TestRenderer.create(createElement(ChannelAddMembersDialog, {
        serverId: "server_1",
        channelId: "channel_1",
        channelName: "private",
        onClose: vi.fn(),
      }))
    })

    expect(mockedDialog.mock.calls.at(-1)![0].queryState).toEqual(expect.objectContaining({
      resolved: true,
      loading: false,
      error: true,
      retrying: false,
    }))
  })
})
