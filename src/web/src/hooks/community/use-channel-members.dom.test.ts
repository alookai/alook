import { createElement, type PropsWithChildren } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { renderHook, waitFor } from "@/test/react-dom-harness"
import { useCommunityWsStore } from "@/stores/community/ws"

const apiFetchMock = vi.fn()

vi.mock("@/lib/api/client", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))

beforeEach(() => {
  apiFetchMock.mockReset()
  useCommunityWsStore.getState().reset()
  useCommunityWsStore.getState().activateProfileAccount("viewer")
})

describe("useChannelMembers", () => {
  it("fetches the roster through the identity-aware query function", async () => {
    apiFetchMock.mockResolvedValue({
      members: [{
        id: "membership_1",
        userId: "member_1",
        name: "Alice",
        discriminator: "0042",
        avatar: "A",
        avatarVersion: 4,
        sub: "",
        role: "member",
        status: "offline",
        statusEmoji: null,
        statusText: "",
        source: "explicit",
        isCreator: false,
      }],
    })
    const { useChannelMembers } = await import("./use-channel-members")
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const wrapper = ({ children }: PropsWithChildren) => createElement(
      QueryClientProvider,
      { client: queryClient },
      children,
    )
    const rendered = renderHook(() => useChannelMembers("private/channel"), { wrapper })

    await waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith(
        "/api/community/channels/private%2Fchannel/members",
      )
    })
    await waitFor(() => expect(rendered.result.current.members).toHaveLength(1))
    expect(useCommunityWsStore.getState().profilesByUserId.get("member_1")).toMatchObject({
      name: "Alice",
      discriminator: "0042",
      avatar: "A",
      avatarVersion: 4,
    })
  })
})
