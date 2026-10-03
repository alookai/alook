import { createElement, type PropsWithChildren } from "react"
import { CommunityTestProvider as QueryClientProvider } from "@/test/community-owner-fixture"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { renderHook, waitFor } from "@/test/react-dom-harness"

const apiFetchMock = vi.fn()

vi.mock("@/lib/api/client", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))

beforeEach(() => {
  apiFetchMock.mockReset()
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
    const queryClient = (await createCommunityQueryOwner()).client
    const wrapper = ({ children }: PropsWithChildren) => createElement(
      QueryClientProvider,
      { client: queryClient },
      children,
    )
    const rendered = renderHook(() => useChannelMembers("private/channel", true, "server_1"), { wrapper })

    await waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith(
        "/api/community/channels/private%2Fchannel/members",
        expect.objectContaining({ signal: expect.any(AbortSignal), authenticationAccount: "viewer" }),
      )
    })
    await waitFor(() => expect(rendered.result.current.members).toHaveLength(1))
  })
})
