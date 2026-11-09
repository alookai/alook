import React from "react"
import { expect, it, vi } from "vitest"
import { act, render, screen } from "@/test/react-dom-harness"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { CommunityTestProvider } from "@/test/community-owner-fixture"
import { CurrentUserProvider } from "@/contexts/community/current-user"

const resolveInvite = vi.hoisted(() => vi.fn())
vi.mock("@/hooks/community/use-invitable-friends", () => ({ useInvitableFriends: () => ({ friends: [], totalFriends: 0, data: { friends: [] }, isLoading: false, isError: false, isFetching: false }) }))
vi.mock("@/hooks/community/use-friends", () => ({ useFriendsPresence: () => ({ online: [] }) }))
vi.mock("@/hooks/community/use-server-panels", () => ({ useInvites: () => ({ invites: [], isLoading: false }) }))
vi.mock("@/hooks/community/mutations", async () => {
  const { useMutation } = await import("@tanstack/react-query")
  return { useResolveOrCreateInvite: () => useMutation({ mutationFn: resolveInvite }), useCreateOrGetDm: () => ({ mutateAsync: vi.fn() }) }
})
vi.mock("@/hooks/community/use-dm-message-sender", () => ({ useDmMessageSender: () => ({ accept: vi.fn() }) }))

import { InviteDialog } from "./invite-dialog"

it("keeps an invitation dialog open without resolving an invite until its original account confirms", async () => {
  const owner = await createCommunityQueryOwner()
  owner.registry.bindAuthentication(() => undefined, async () => {})
  resolveInvite.mockReset().mockResolvedValue({ token: "invite" })
  render(<CommunityTestProvider client={owner.client} registry={owner.registry}>
    <CurrentUserProvider initialUser={{ id: "viewer", email: "viewer@example.test" }}>
      <InviteDialog open onOpenChange={() => {}} serverId="s1" serverName="Server" />
    </CurrentUserProvider>
  </CommunityTestProvider>)
  expect(screen.getByRole("dialog")).toBeInTheDocument()
  expect(resolveInvite).not.toHaveBeenCalled()
  await act(async () => { owner.registry.bindAuthentication(() => "viewer", async () => {}); owner.registry.confirmAuthentication() })
  expect(resolveInvite).toHaveBeenCalledOnce()
  expect(screen.getByRole("dialog")).toBeInTheDocument()
})
